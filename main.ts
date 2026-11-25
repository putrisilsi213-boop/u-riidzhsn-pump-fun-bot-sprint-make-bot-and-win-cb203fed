// Breakout Rider — momentum breakout bot for the pump.fun replay.
// Node 22, stdlib only, no network, deterministic. See strategy.ts for the rules.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
