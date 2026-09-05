// The `lib` object handed to every generated `decide(market, params, lib)`.
// Small, pure, and DEFENSIVE: each helper returns NaN / 0 / undefined on empty
// or malformed input and never throws, so a generated strategy can lean on it
// instead of hand-rolling (buggy) rolling-window math. Frozen so the sandbox
// can't mutate it.
//
// This exact module is imported by the worker (code-runner.worker.ts) and the
// synthetic dry-run, and its signatures are quoted verbatim in the codegen
// prompt (strategy-gen.ts).

function nums(a: unknown): number[] {
  return Array.isArray(a) ? (a.filter((x) => typeof x === "number" && Number.isFinite(x)) as number[]) : [];
}

function mean(a: number[]): number {
  const v = nums(a);
  if (v.length === 0) return NaN;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

function stddev(a: number[]): number {
  const v = nums(a);
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
}

/** Simple moving average of the last `period` values (default: whole array). */
function sma(a: number[], period?: number): number {
  const v = nums(a);
  if (v.length === 0) return NaN;
  const p = period && period > 0 ? Math.min(period, v.length) : v.length;
  return mean(v.slice(-p));
}

/** Exponential moving average, seeded from the first value. */
function ema(a: number[], period?: number): number {
  const v = nums(a);
  if (v.length === 0) return NaN;
  const p = period && period > 1 ? period : v.length;
  const k = 2 / (p + 1);
  let e = v[0]!;
  for (let i = 1; i < v.length; i++) e = v[i]! * k + e * (1 - k);
  return e;
}

/** Least-squares slope of `a` against its index (0,1,2,…). Units: value per step. */
function linregSlope(a: number[]): number {
  const v = nums(a);
  const n = v.length;
  if (n < 2) return NaN;
  const xm = (n - 1) / 2;
  const ym = mean(v);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (v[i]! - ym);
    den += (i - xm) * (i - xm);
  }
  return den === 0 ? NaN : num / den;
}

/** Fractional change from `from` to `to` (e.g. 0.02 = +2%). */
function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return NaN;
  return (to - from) / from;
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** How many standard deviations `x` is from the mean of `a`. */
function zscore(x: number, a: number[]): number {
  const sd = stddev(a);
  if (!Number.isFinite(sd) || sd === 0) return 0;
  return (x - mean(a)) / sd;
}

function last(a: number[]): number | undefined {
  const v = nums(a);
  return v.length ? v[v.length - 1] : undefined;
}

export const LIB = Object.freeze({
  mean,
  stddev,
  sma,
  ema,
  linregSlope,
  pctChange,
  clamp,
  zscore,
  last,
});

export type StrategyLib = typeof LIB;

/** Human-readable signatures for the codegen prompt (kept next to the impls so they can't drift). */
export const LIB_SIGNATURES = [
  "lib.mean(nums: number[]): number            // NaN if empty",
  "lib.stddev(nums: number[]): number          // sample stddev; NaN if < 2 values",
  "lib.sma(nums: number[], period?): number    // simple moving average of the last `period`",
  "lib.ema(nums: number[], period?): number    // exponential moving average",
  "lib.linregSlope(nums: number[]): number     // least-squares slope vs index; value per step; NaN if < 2",
  "lib.pctChange(from: number, to: number): number   // (to-from)/from",
  "lib.clamp(x: number, lo: number, hi: number): number",
  "lib.zscore(x: number, nums: number[]): number     // std-devs from the mean",
  "lib.last(nums: number[]): number | undefined",
].join("\n");
