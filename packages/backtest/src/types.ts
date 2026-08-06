import type { SimPool } from "./sim/sim-pool.js";

export type LogFn = (msg: string, extra?: unknown) => void;

export interface BotHandle {
  onBar(): Promise<void>;
  finish?(): Promise<void>;
  warmupBars?: number;
}

/** Factory that wires a strategy to a SimPool for one backtest run. */
export type BotFactory = (pool: SimPool, log: LogFn) => Promise<BotHandle> | BotHandle;
