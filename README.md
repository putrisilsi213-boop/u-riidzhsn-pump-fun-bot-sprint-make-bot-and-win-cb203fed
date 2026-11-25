# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/putrisilsi213-boop/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/putrisilsi213-boop/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Breakout Rider — a disciplined momentum bot for pump.fun bonding-curve replays. It buys only confirmed, broad-based breakouts (price +5–80% over 25 trades, net buy flow ≥ +0.30 SOL, buys ≥ 90% of trades, ≥ 6 distinct buyers, no whale dump) with tiny fixed 0.05 SOL probes, then exits fast on a −10% stop, +15% take-profit, trailing stop, half-profit at +10%, or a time stop. Slot-based coverage pacing loosens the entry bars late in the window so the 20-coin guardrail stays in reach. Node 22, stdlib only, no network, fully deterministic.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`); the strategy lives in `strategy.ts`. Local backtest on the kit's dev dataset: net −0.165 SOL, 83 round trips, 33 wins, max drawdown 1.9% (24 h dev window; the final tape is unseen, so the bot is built for robustness, not for the dev numbers).

---

<sub>Entered on [make.fun](https://make.fun/?ref=d6m6thj3&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
