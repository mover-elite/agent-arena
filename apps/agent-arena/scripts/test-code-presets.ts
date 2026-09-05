// Exercises server/strategy-code-presets.ts — every prebuilt coded strategy must
// pass the sandbox's static gate, run clean on a populated market, and ABSTAIN
// (not throw) on a market with nothing in it.
//   npx tsx scripts/test-code-presets.ts
import assert from "node:assert/strict";
import { runStrategyCode, staticReject } from "../server/code-runner.js";
import {
  CODE_PRESETS,
  getCodePreset,
  paramsForCodePreset,
  validateCodePreset,
} from "../server/strategy-code-presets.js";
import type { CodeMarketView } from "../server/types.js";

const now = Math.floor(Date.now() / 1000);

// Populated market with a clean up-trend and spot above the strike.
const FULL: CodeMarketView = {
  marketId: "0x" + "11".repeat(32),
  symbol: "BTC-0-03SEP26-1700/tUSDC",
  asset: "BTC",
  question: "BTC closes at or above its opening price",
  intervalSec: 3600,
  secondsToExpiry: 1500,
  tradingStart: now - 2100,
  expiresAt: now + 1500,
  yesMid: 0.5,
  bestYesBid: 0.49,
  bestYesAsk: 0.51,
  spread: 0.02,
  recentHistory: [0.48, 0.49, 0.5, 0.5, 0.51, 0.5],
  history: Array.from({ length: 60 }, (_, i) => 0.5 + Math.sin(i / 7) * 0.02),
  strike: 77000,
  underlying: {
    price: 77600,
    ema: 77500,
    change24hPct: 0.8,
    high24h: 77800,
    low24h: 76500,
    candles: Array.from({ length: 120 }, (_, i) => {
      const c = 77000 + i * 5; // monotone up
      return [Date.now() - (120 - i) * 60_000, c - 2, c + 6, c - 6, c, 10] as [number, number, number, number, number, number];
    }),
  },
};

// Nothing readable — every preset must return null here, never throw.
const BARE: CodeMarketView = {
  ...FULL,
  marketId: "0x" + "22".repeat(32),
  symbol: "ETH-0-04SEP26/tUSDC",
  asset: "ETH",
  yesMid: null,
  bestYesBid: null,
  bestYesAsk: null,
  spread: null,
  strike: null,
  underlying: null,
  history: [],
  recentHistory: [],
};

// Longer-interval market: underlying present, strike unreadable.
const NO_STRIKE: CodeMarketView = { ...FULL, marketId: "0x" + "33".repeat(32), strike: null };

// Tight band near 0.5 with the mid sitting clearly above the band centre.
const TIGHT_RANGE: CodeMarketView = {
  ...FULL,
  marketId: "0x" + "44".repeat(32),
  yesMid: 0.53,
  spread: 0.02,
  history: Array.from({ length: 40 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.005 : -0.005)),
  recentHistory: Array.from({ length: 20 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.005 : -0.005)),
};

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
    fail++;
  }
}

function assertProbInRange(d: { fairUpProbability: number; confidence: number; reasoning: string }) {
  assert.ok(d.fairUpProbability > 0 && d.fairUpProbability < 1, `fairUpProbability out of (0,1): ${d.fairUpProbability}`);
  assert.ok(d.confidence > 0 && d.confidence < 1, `confidence out of (0,1): ${d.confidence}`);
  assert.ok(d.reasoning.trim().length > 0, "empty reasoning");
}

console.log(`code presets: ${CODE_PRESETS.map((p) => p.id).join(", ")}\n`);

for (const p of CODE_PRESETS) {
  const defaults = paramsForCodePreset(p);

  await t(`${p.id}: passes staticReject`, () => {
    assert.equal(staticReject(p.code), null);
  });

  await t(`${p.id}: description/explanation within caps`, () => {
    assert.ok(p.description.length <= 2000, `description ${p.description.length} > 2000`);
    assert.ok(p.explanation.length <= 1200, `explanation ${p.explanation.length} > 1200`);
    assert.ok(p.paramSchema.length > 0, "no params");
    for (const f of p.paramSchema) {
      assert.match(f.key, /^[a-zA-Z][a-zA-Z0-9_]*$/);
      if (f.type === "number") {
        assert.equal(typeof f.default, "number");
        if (f.min != null) assert.ok((f.default as number) >= f.min, `${f.key} default < min`);
        if (f.max != null) assert.ok((f.default as number) <= f.max, `${f.key} default > max`);
      } else {
        assert.equal(typeof f.default, "boolean");
      }
    }
  });

  await t(`${p.id}: validateCodePreset -> ok`, async () => {
    const v = await validateCodePreset(p);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
  });

  await t(`${p.id}: runs clean on a populated market`, async () => {
    const r = await runStrategyCode(p.code, defaults, [FULL], { timeoutMs: 2000 });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.message}`);
    if (r.ok) {
      assert.equal(r.results.length, 1);
      const d = r.results[0]!.decision;
      if (d) assertProbInRange(d);
    }
  });

  await t(`${p.id}: ABSTAINS on an empty market (no throw)`, async () => {
    const r = await runStrategyCode(p.code, defaults, [BARE], { timeoutMs: 2000 });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.message}`);
    if (r.ok) assert.equal(r.results[0]!.decision, null, "should abstain when nothing is readable");
  });

  await t(`${p.id}: no throw when strike is unreadable`, async () => {
    const r = await runStrategyCode(p.code, defaults, [NO_STRIKE], { timeoutMs: 2000 });
    assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.message}`);
  });

  await t(`${p.id}: param extremes don't crash`, async () => {
    const lo: Record<string, number | boolean> = {};
    const hi: Record<string, number | boolean> = {};
    for (const f of p.paramSchema) {
      if (f.type === "number") {
        lo[f.key] = f.min ?? (f.default as number);
        hi[f.key] = f.max ?? (f.default as number);
      } else {
        lo[f.key] = false;
        hi[f.key] = true;
      }
    }
    for (const params of [lo, hi]) {
      const r = await runStrategyCode(p.code, params, [FULL, BARE, TIGHT_RANGE], { timeoutMs: 2000 });
      assert.equal(r.ok, true, r.ok ? "" : `${r.kind}: ${r.message}`);
      if (r.ok) for (const res of r.results) if (res.decision) assertProbInRange(res.decision);
    }
  });
}

// ── Per-strategy directional sanity ───────────────────────────────────────────

await t("oracle-follow: spot well above strike -> leans Up", async () => {
  const r = await runStrategyCode(
    CODE_PRESETS.find((p) => p.id === "oracle-follow")!.code,
    { lookbackCandles: 10, expectedMove: 0.0015, minEdge: 0 },
    [FULL],
    { timeoutMs: 2000 },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const d = r.results[0]!.decision;
    assert.ok(d && d.fairUpProbability > 0.5, `expected Up lean, got ${d?.fairUpProbability}`);
  }
});

await t("momentum: clean up-trend -> fair Up >= market mid", async () => {
  const r = await runStrategyCode(
    CODE_PRESETS.find((p) => p.id === "momentum")!.code,
    { windowSize: 20, entryMomentum: 0.0005, sensitivity: 20, breakoutOnly: false },
    [FULL],
    { timeoutMs: 2000 },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const d = r.results[0]!.decision;
    assert.ok(d && d.fairUpProbability >= FULL.yesMid!, `expected >= ${FULL.yesMid}, got ${d?.fairUpProbability}`);
  }
});

await t("range-fade: mid above a tight band centre -> fades Down", async () => {
  const r = await runStrategyCode(
    CODE_PRESETS.find((p) => p.id === "range-fade")!.code,
    paramsForCodePreset(CODE_PRESETS.find((p) => p.id === "range-fade")!),
    [TIGHT_RANGE],
    { timeoutMs: 2000 },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const d = r.results[0]!.decision;
    assert.ok(d && d.fairUpProbability < TIGHT_RANGE.yesMid!, `expected fade below ${TIGHT_RANGE.yesMid}, got ${d?.fairUpProbability}`);
  }
});

await t("getCodePreset: known id resolves, unknown -> undefined", () => {
  assert.equal(getCodePreset("nope"), undefined);
  assert.equal(getCodePreset("oracle-follow")?.id, "oracle-follow");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
