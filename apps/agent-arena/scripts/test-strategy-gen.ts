// Live generation smoke test — needs a real key.
//   LLM_PROVIDER + ANTHROPIC_API_KEY|GEMINI_API_KEY from the repo-root .env, or
//   pass --provider anthropic --key sk-... [--model ...]
import assert from "node:assert/strict";
import { loadEnv } from "@dreamdex-bot-kit/ec-core";
import { generateStrategy, finalizeRaw } from "../server/strategy-gen.js";
import { runStrategyCode } from "../server/code-runner.js";
import type { RawGeneratedStrategy } from "../server/llm-providers/codegen.js";
import type { LlmProviderName } from "../server/types.js";

loadEnv();

// --- offline: the validate + dry-run acceptance path, no LLM needed ---
if (process.argv.includes("--offline") || process.argv.includes("--mock")) {
  const GOOD: RawGeneratedStrategy = {
    name: "Candle Momentum",
    blurb: "Bets with a clean short-term trend in the underlying's 1m closes.",
    explanation: "Fits a line to the last N one-minute closes; leans Up if the slope is clearly positive, Down if clearly negative, else no opinion.",
    code: "(market, params, lib) => { const u = market.underlying; if (!u || u.candles.length < params.lookback || market.yesMid == null) return null; const closes = u.candles.slice(-params.lookback).map(c => c[4]); const slope = lib.linregSlope(closes); const norm = slope / (lib.mean(closes) || 1); if (!Number.isFinite(norm) || Math.abs(norm) < params.minSlope) return null; const push = lib.clamp(norm * params.gain, -params.maxPush, params.maxPush); const fair = lib.clamp(market.yesMid + push, 0.02, 0.98); return { fairUpProbability: fair, confidence: lib.clamp(0.4 + Math.abs(norm) * params.confGain, 0.02, 0.9), reasoning: 'close slope ' + norm.toFixed(6) }; }",
    params: { lookback: 20, minSlope: 0.00002, gain: 6, maxPush: 0.15, confGain: 2000 },
    paramSchema: [
      { key: "lookback", label: "Candles to fit", type: "number", default: 20, min: 5, max: 120, step: 1 },
      { key: "minSlope", label: "Min normalized slope", type: "number", default: 0.00002, min: 0, max: 0.001, step: 0.00001 },
      { key: "gain", label: "Slope gain", type: "number", default: 6, min: 1, max: 40, step: 1 },
      { key: "maxPush", label: "Max deviation", type: "number", default: 0.15, min: 0.02, max: 0.4, step: 0.01 },
      { key: "confGain", label: "Confidence gain", type: "number", default: 2000, min: 100, max: 10000, step: 100 },
    ],
  };
  let p = 0;
  let f = 0;
  const t = async (n: string, fn: () => Promise<void>) => {
    try { await fn(); console.log("  ok  ", n); p++; } catch (e) { console.log("  FAIL", n, "-", (e as Error).message); f++; }
  };

  await t("good artifact -> ok, params from schema defaults", async () => {
    const r = await finalizeRaw(GOOD, { description: "trend follower", provider: "anthropic" }, "test");
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.params.lookback, 20); assert.equal(r.spec.paramSchema.length, 5); }
  });
  await t("model params override schema defaults for declared keys only", async () => {
    const r = await finalizeRaw({ ...GOOD, params: { lookback: 45, bogus: 9 } }, { description: "x", provider: "anthropic" }, "test");
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.params.lookback, 45); assert.equal("bogus" in r.params, false); }
  });
  await t("code with `process` -> rejected", async () => {
    const r = await finalizeRaw({ ...GOOD, code: "(m,p,l) => { return process.env; }" }, { description: "x", provider: "anthropic" }, "test");
    assert.equal(r.ok, false);
  });
  await t("param default type mismatch -> rejected", async () => {
    const r = await finalizeRaw({ ...GOOD, paramSchema: [{ key: "lookback", label: "x", type: "number", default: true }] as RawGeneratedStrategy["paramSchema"] }, { description: "x", provider: "anthropic" }, "test");
    assert.equal(r.ok, false);
  });
  await t("code that throws on the null-underlying synth market -> rejected", async () => {
    const r = await finalizeRaw({ ...GOOD, code: "(m,p,l) => { return { fairUpProbability: m.underlying.price > 0 ? 0.6 : 0.4, confidence: 0.5, reasoning: 'x' }; }" }, { description: "x", provider: "anthropic" }, "test");
    assert.equal(r.ok, false);
  });
  console.log(`\n${p} passed, ${f} failed (offline)`);
  process.exit(f === 0 ? 0 : 1);
}
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const provider = (arg("--provider") ?? process.env.LLM_PROVIDER ?? "anthropic").toLowerCase() as LlmProviderName;
const apiKey = arg("--key") ?? (provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY);
const model = arg("--model") ?? (provider === "gemini" ? process.env.GEMINI_MODEL : process.env.ANTHROPIC_MODEL);
if (!apiKey) {
  console.error(`no ${provider} key (set ${provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} or pass --key)`);
  process.exit(1);
}

const DESCRIPTIONS = [
  "Buy Up when the last 15 one-minute closes of the underlying are clearly trending upward; buy Down when clearly trending down; otherwise no opinion.",
  "A contrarian: when the implied Up probability has spiked more than 8 points in the recent history with no matching move in the underlying price, fade it back toward where it was.",
];

for (const description of DESCRIPTIONS) {
  console.log("\n=== description ===\n" + description);
  const t0 = Date.now();
  const r = await generateStrategy({ description, provider, apiKey, model });
  console.log(`generateStrategy -> ${r.ok ? "ok" : "FAIL"} in ${Date.now() - t0}ms`);
  if (!r.ok) {
    console.log("  error:", r.error);
    process.exitCode = 1;
    continue;
  }
  console.log("  blurb:", r.spec.blurb);
  console.log("  explanation:", r.spec.explanation);
  console.log("  params:", JSON.stringify(r.params));
  console.log("  paramSchema keys:", r.spec.paramSchema.map((f) => `${f.key}:${f.type}`).join(", "));
  console.log("  code:\n" + r.code.split("\n").map((l) => "    " + l).join("\n"));
  // re-run once more against synth markets to be sure it's reproducibly clean
  const again = await runStrategyCode(r.code, r.params, [], { timeoutMs: 1000 });
  console.log("  empty-market run:", again.ok ? "ok (0 results)" : `${again.kind}: ${again.message}`);
}

console.log("\ndone");
