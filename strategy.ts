// Breakout Rider — a disciplined momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins rug, so the edge is not in catching every pump but in
// buying only confirmed, broad-based breakouts with tiny fixed stakes, then exiting
// fast on a tight stop, a take-profit, or a trailing stop. No pyramiding, no chasing
// parabolic tops, no holding dead coins.
//
// Entry (all must hold, evaluated on a mint's fresh trades each batch):
//   - at least 25 trades seen, price up 5%..80% over the last 25 trades (momentum
//     with confirmation, but not a vertical top), net buy flow >= +0.30 SOL over
//     those trades, buys >= 90% of trades, >= 6 distinct buyers (broad, one-sided
//     demand, not one wallet wash-trading), real SOL reserves 1..80 SOL (not dust,
//     not already a giant), and no single sell > 1 SOL in the last 10 trades (no
//     whale dumping into the move).
//   - stake is a fixed 0.05 SOL probe (well above the 0.01 SOL round-trip floor the
//     guardrails need, small enough that a full stop-out costs ~0.5% of capital),
//     capped by the harness per-order size cap and free cash. Max 5 open positions
//     (the harness cap), at most 2 entries per mint, 600-slot cooldown after an exit.
//   - coverage pacing: the final window is ~100k slots, and the guardrails need
//     round trips on at least 20 coins, so if fewer than 12 coins are entered by
//     slot 25k (or fewer than 18 by slot 50k) the buy-share / rise bars loosen
//     (90% -> 65% -> 60%, +5% -> +4% -> +3%) to keep coverage on track.
//
// Exits (checked every batch from the live curve price vs. the position's cost,
// which already includes fees):
//   - hard stop -10%, take-profit +15%,
//   - trailing stop once +8% is reached: sell if PnL falls 6pp below its peak,
//   - partial take-profit: bank half at +10%,
//   - time stop: after 1500 slots (~5 min) sell unless up at least +5%.
//
// Fees: a 0.05 SOL round trip costs ~1.25% curve fee each way + 0.000105 SOL tx
// fee per order, ~3% of stake, so the +15% take-profit and -10% stop keep the
// fee drag small relative to the move being captured. The 90% buy-share bar and
// the 500 bps buy slippage are the main edge: they reject fills where the price
// already ran away in the 2-slot latency, and they keep the bot out of the
// two-sided chop where most naive momentum bots bleed.
//
// Deterministic: pure integer (BigInt) math on reserves and trade amounts, no
// clock, no environment, no randomness. Every decision derives from the harness
// state, so the two grading runs produce identical action logs.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type ChainEvent,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  lookbackTrades: number;
  minTrades: number;
  minBuyers: number;
  minUpBps: number;
  maxUpBps: number;
  minNetLamports: bigint;
  minBuyShareBps: number;
  minRealLamports: bigint;
  maxRealLamports: bigint;
  maxWhaleSellLamports: bigint;
  stakeLamports: bigint;
  buySlipBps: number;
  sellSlipBps: number;
  stopBps: number;
  takeProfitBps: number;
  trailArmBps: number;
  trailDropBps: number;
  maxHoldSlots: number;
  timeStopMinBps: number;
  cooldownSlots: number;
  maxEntriesPerMint: number;
  /** Sell half at this PnL (0 disables); the rest rides to TP / trail / stop. */
  partialTpBps: number;
  /** Pacing: the final window is ~100k slots; if coverage lags, loosen entry. */
  paceSlot1: number;
  paceCoins1: number;
  paceSlot2: number;
  paceCoins2: number;
}

export const DEFAULT_PARAMS: Params = {
  lookbackTrades: 25,
  minTrades: 25,
  minBuyers: 6,
  minUpBps: 500,
  maxUpBps: 8000,
  minNetLamports: 300_000_000n, // +0.30 SOL net buy flow over the window
  minBuyShareBps: 9000, // buys >= 90% of window trades: only one-sided order flow
  minRealLamports: 1_000_000_000n, // 1 SOL in the real reserve
  maxRealLamports: 80_000_000_000n, // 80 SOL
  maxWhaleSellLamports: 1_000_000_000n, // no single sell > 1 SOL recently
  stakeLamports: 50_000_000n, // 0.05 SOL probe
  buySlipBps: 500,
  sellSlipBps: 10000,
  stopBps: -1000, // -10%
  takeProfitBps: 1500, // +15%
  trailArmBps: 800, // trail arms at +8%
  trailDropBps: 600, // sell 6pp below the peak
  maxHoldSlots: 1500, // ~5 minutes
  timeStopMinBps: 500, // time stop spares positions up >= +5%
  cooldownSlots: 600,
  maxEntriesPerMint: 2,
  partialTpBps: 1000, // bank half at +10%
  paceSlot1: 25000,
  paceCoins1: 12,
  paceSlot2: 50000,
  paceCoins2: 18,
};

interface Trade {
  slot: number;
  vq: bigint; // virtual quote reserves after the trade
  vt: bigint; // virtual token reserves after the trade
  isBuy: boolean;
  sol: bigint; // SOL moved by this trade
  user: Pubkey;
}

interface Tape {
  createdSlot: number | null;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  entrySlot: number;
  peakBps: number;
  partialTaken: boolean;
}

const BPS = 10_000n;

/** Price (SOL per token) as a fraction vq/vt; ratios are compared cross-multiplied. */
function priceUpBps(first: Trade, last: Trade): bigint {
  // (last.vq/last.vt) / (first.vq/first.vt) - 1, in bps
  // = (last.vq * first.vt * 10000) / (last.vt * first.vq) - 10000
  const num = last.vq * first.vt * BPS;
  const den = last.vt * first.vq;
  if (den === 0n) return 0n;
  return num / den - BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Distinct mints this bot has entered (for the coverage pacing). */
  const myCoins = new Set<Pubkey>();
  /** Slot of the first batch seen; pacing is measured from here. */
  let firstSlot: number | null = null;

  /** Effective entry thresholds for this slot: strict early, looser late if coverage lags. */
  const effectiveEntry = (slot: number): { shareBps: number; minUpBps: number; minBuyers: number } => {
    const eff = { shareBps: p.minBuyShareBps, minUpBps: p.minUpBps, minBuyers: p.minBuyers };
    if (firstSlot === null) return eff;
    const elapsed = slot - firstSlot;
    if (elapsed >= p.paceSlot2 && myCoins.size < p.paceCoins2) {
      eff.shareBps = 6000;
      eff.minUpBps = 300;
      eff.minBuyers = 5;
    } else if (elapsed >= p.paceSlot1 && myCoins.size < p.paceCoins1) {
      eff.shareBps = 6500;
      eff.minUpBps = 400;
    }
    return eff;
  };

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  const foldEvent = (e: ChainEvent): void => {
    if (e.event === 'CreateEvent') {
      tapeOf(e.mint).createdSlot = e.slot;
      return;
    }
    if (e.event !== 'TradeEvent') {
      if (e.event === 'CompleteEvent') {
        const t = tapes.get(e.mint);
        if (t !== undefined) t.trades.length = 0;
      }
      return;
    }
    const t = tapeOf(e.mint);
    t.trades.push({
      slot: e.slot,
      vq: BigInt(e.virtual_quote_reserves),
      vt: BigInt(e.virtual_token_reserves),
      isBuy: e.is_buy,
      sol: BigInt(e.sol_amount),
      user: e.user,
    });
    // Keep only the recent tape: lookback + a little slack.
    const keep = p.lookbackTrades + 5;
    if (t.trades.length > keep) t.trades.splice(0, t.trades.length - keep);
  };

  /** Current mark price of a mint from its latest curve reserves, or null. */
  const markPrice = (state: BotState, mint: Pubkey): { vq: bigint; vt: bigint } | null => {
    const c = state.curves.get(mint);
    if (c === undefined || c.complete) return null;
    if (c.virtual_token_reserves === 0n || c.virtual_quote_reserves === 0n) return null;
    return { vq: c.virtual_quote_reserves, vt: c.virtual_token_reserves };
  };

  /** PnL of a held position in bps vs its fee-inclusive cost, or null. */
  const positionPnlBps = (
    state: BotState,
    mint: Pubkey,
    tokens: bigint,
    cost: bigint,
  ): number | null => {
    const mark = markPrice(state, mint);
    if (mark === null || cost === 0n) return null;
    const value = (tokens * mark.vq) / mark.vt;
    return Number(((value - cost) * BPS) / cost);
  };

  const entrySignal = (state: BotState, mint: Pubkey): boolean => {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves < p.minRealLamports) return false;
    if (curve.real_quote_reserves > p.maxRealLamports) return false;
    const t = tapes.get(mint);
    if (t === undefined || t.trades.length < p.minTrades) return false;
    if (t.entries >= p.maxEntriesPerMint) return false;
    if (state.slot - t.lastExitSlot < p.cooldownSlots) return false;

    const w = t.trades.slice(-p.lookbackTrades);
    const first = w[0];
    const last = w[w.length - 1];
    if (first === undefined || last === undefined) return false;
    const eff = effectiveEntry(state.slot);
    const up = priceUpBps(first, last);
    if (up < BigInt(eff.minUpBps) || up > BigInt(p.maxUpBps)) return false;

    let net = 0n;
    let buys = 0;
    const buyers = new Set<Pubkey>();
    for (const tr of w) {
      if (tr.isBuy) {
        net += tr.sol;
        buys += 1;
        buyers.add(tr.user);
      } else {
        net -= tr.sol;
      }
    }
    if (net < p.minNetLamports) return false;
    if (BigInt(buys) * BPS < BigInt(eff.shareBps) * BigInt(w.length)) return false;
    if (buyers.size < eff.minBuyers) return false;

    // No whale dump into the move: no single sell over the cap in the last 10 trades.
    const lastTen = t.trades.slice(-10);
    for (const tr of lastTen) {
      if (!tr.isBuy && tr.sol > p.maxWhaleSellLamports) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot === null) firstSlot = state.slot;
      const orders: OrderInput[] = [];
      const touched = new Set<Pubkey>();

      for (const e of batch.events) {
        foldEvent(e);
        if (e.event === 'TradeEvent' || e.event === 'CreateEvent') touched.add(e.mint);
      }

      // Forget positions that are gone (sold, completed, flattened) and arm cooldowns.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          tapeOf(mint).lastExitSlot = state.slot;
        }
      }
      // Track newly filled positions.
      for (const [mint, pos] of state.positions) {
        if (!held.has(mint)) held.set(mint, { entrySlot: state.slot, peakBps: 0, partialTaken: false });
        void pos;
      }

      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }

      // --- exits first: free the slot (and the cash) before entering anything new.
      for (const [mint, pos] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const h = held.get(mint);
        if (h === undefined) continue;
        const pnl = positionPnlBps(state, mint, pos.token_amount, pos.cost_lamports);
        if (pnl === null) continue;
        if (pnl > h.peakBps) h.peakBps = pnl;
        // Bank half at the partial take-profit, once; the rest rides on.
        if (p.partialTpBps > 0 && !h.partialTaken && pnl >= p.partialTpBps && pnl < p.takeProfitBps) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount / 2n,
            max_slippage_bps: p.sellSlipBps,
          });
          h.partialTaken = true;
          pendingSell.add(mint);
          continue;
        }
        const age = state.slot - h.entrySlot;
        const stopHit = pnl <= p.stopBps;
        const tpHit = pnl >= p.takeProfitBps;
        const trailHit = h.peakBps >= p.trailArmBps && pnl <= h.peakBps - p.trailDropBps;
        const timeHit = age > p.maxHoldSlots && pnl < p.timeStopMinBps;
        if (stopHit || tpHit || trailHit || timeHit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: p.sellSlipBps,
          });
          pendingSell.add(mint);
        }
      }

      // --- entries: one probe per qualifying mint, while slots and cash allow.
      // runBot only records these orders after onBatch returns, so track the
      // slots and cash this batch's own buys consume locally.
      const maxPos = state.hello.caps.max_open_positions;
      let committed = state.committedPositionCount();
      let free = state.freeCashLamports();
      for (const mint of touched) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        if (committed >= maxPos) break;
        if (!entrySignal(state, mint)) continue;
        const cap = state.maxBuyLamports(mint);
        let stake = p.stakeLamports;
        if (stake > cap) stake = cap;
        if (stake > free - state.txFeeLamports()) stake = free - state.txFeeLamports();
        if (stake < 10_000_000n) continue; // 0.01 SOL round-trip floor
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: p.buySlipBps });
        pendingBuy.add(mint);
        committed += 1;
        free -= stake + state.txFeeLamports();
        tapeOf(mint).entries += 1;
        myCoins.add(mint);
      }

      return orders;
    },
  };
}
