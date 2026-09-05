// Exercises server/code-runner.ts against valid + hostile generated code.
//   npx tsx scripts/test-code-runner.ts
import assert from "node:assert/strict";
import { runStrategyCode } from "../server/code-runner.js";
import type { CodeMarketView } from "../server/types.js";

const MARKET: CodeMarketView = {
  marketId: "0x" + "ab".repeat(32),
  symbol: "BTC-0-03SEP26-1700/tUSDC",
  asset: "BTC",
  question: "BTC closes at or above its opening price",
  intervalSec: 3600,
  secondsToExpiry: 1800,
  tradingStart: Math.floor(Date.now() / 1000) - 1800,
  expiresAt: Math.floor(Date.now() / 1000) + 1800,
  yesMid: 0.55,
  bestYesBid: 0.54,
  bestYesAsk: 0.56,
  spread: 0.02,
  recentHistory: [0.5, 0.51, 0.52, 0.53, 0.54, 0.55],
  history: Array.from({ length: 40 }, (_, i) => 0.4 + i * 0.004),
  strike: 77000,
  underlying: {
    price: 77250,
    ema: 77240,
    change24hPct: 0.3,
    high24h: 77500,
    low24h: 76800,
    candles: Array.from({ length: 30 }, (_, i) => [Date.now() - (30 - i) * 60000, 77000 + i * 8, 77000 + i * 8 + 5, 77000 + i * 8 - 5, 77000 + i * 8 + 3, 10] as [number, number, number, number, number, number]),
  },
};

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
    fail++;
  }
}

await t("valid momentum code -> ok with in-range fields", async () => {
  const code = `(m, p, lib) => {
    const slope = lib.linregSlope(m.recentHistory);
    if (!Number.isFinite(slope) || Math.abs(slope) < p.minSlope) return null;
    const fair = lib.clamp((m.yesMid ?? 0.5) + Math.sign(slope) * p.push, 0.02, 0.98);
    return { fairUpProbability: fair, confidence: 0.6, reasoning: "slope " + slope.toFixed(4) };
  }`;
  const r = await runStrategyCode(code, { minSlope: 0.001, push: 0.05 }, [MARKET]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.results.length, 1);
    const d = r.results[0]!.decision!;
    assert.ok(d.fairUpProbability > 0 && d.fairUpProbability < 1);
    assert.ok(d.reasoning.length > 0);
  }
});

await t("return null -> ok with decision:null", async () => {
  const r = await runStrategyCode("(m,p,l) => null", {}, [MARKET]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.results[0]!.decision, null);
});

await t("throw -> kind:throw", async () => {
  const r = await runStrategyCode("(m,p,l) => { throw new Error('boom'); }", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "throw");
});

await t("while(true) -> static_reject (no worker spawned)", async () => {
  const r = await runStrategyCode("(m,p,l) => { while(true){} }", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "static_reject");
});

await t("for(;;) heap spin -> process SURVIVES, kind:timeout", async () => {
  // dodge the static for(;;) check with a while-condition the regex misses
  const r = await runStrategyCode("(m,p,l) => { const a=[]; let x=1; while(x>0){ a.push(x); } }", {}, [MARKET], { timeoutMs: 400 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.kind === "timeout" || r.kind === "throw"); // "Invalid array length" throw is also acceptable containment
});

await t("out-of-range probability -> kind:bad_return", async () => {
  const r = await runStrategyCode("(m,p,l) => ({ fairUpProbability: 2, confidence: 0.5, reasoning: 'x' })", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "bad_return");
});

await t("non-object return -> kind:bad_return", async () => {
  const r = await runStrategyCode("(m,p,l) => 'nope'", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "bad_return");
});

await t("not a function -> kind:compile", async () => {
  const r = await runStrategyCode("42", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "compile");
});

await t("require present -> static_reject", async () => {
  const r = await runStrategyCode("(m,p,l) => { const fs = require('fs'); return null; }", {}, [MARKET]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "static_reject");
});

await t("multi-market -> one result per market, main process fine", async () => {
  const r = await runStrategyCode("(m,p,l) => ({ fairUpProbability: 0.5001, confidence: 0.5, reasoning: m.symbol })", {}, [MARKET, { ...MARKET, marketId: "0x" + "cd".repeat(32), symbol: "ETH-x" }]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.results.length, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
