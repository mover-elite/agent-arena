// Prebuilt "coded" strategy presets — hand-authored `decide(market, params, lib)`
// functions ported from the kit's own bot packages (repo-root `strategies/`).
//
// Picking one on the create screen makes a `strategy_kind="code"` agent whose
// generated_code / generated_params / generated_spec are written straight from
// the entry below: NO LLM call, NO API key. From then on it's an ordinary coded
// agent — the same worker_threads sandbox runs its `decide()` every cycle for
// free (see code-runner.ts / agent-engine.ts).
//
// Each `code` string must satisfy the shipped sandbox contract:
//   • a single arrow expression `(market, params, lib) => { ... }`
//     (the worker does `(0,eval)("(" + code + ")")`)
//   • pass `staticReject` — no require/process/fetch/eval/import/async/await, no
//     `while(true)` / `for(;;)`, no `Function(`, ≤ 8000 chars. Ordinary counted
//     `for (let i…; i<…; i++)` loops are fine. Keep those banned tokens out of
//     comments and reasoning strings inside `code` too (the regexes scan the
//     whole string).
//   • return `{ fairUpProbability, confidence, reasoning }` with BOTH
//     probabilities strictly inside (0,1) — every path ends in
//     `lib.clamp(x, lo, hi)` with lo ≥ 0.05, hi ≤ 0.95 — or `return null` to
//     abstain.
//   • guard every nullable field (underlying / strike / yesMid / spread) and
//     every array length before indexing.

import { runStrategyCode, staticReject } from "./code-runner.js";
import type { CodeMarketView, GeneratedParamField, GeneratedStrategySpec } from "./types.js";

export interface CodePreset {
  id: string;
  /** Default agent name. */
  name: string;
  /** One line for the gallery card. */
  blurb: string;
  /** Read-only "what it does" prose. Stored verbatim as the agent's
   *  strategyPrompt AND `spec.sourceDescription`. Kept < 2000 chars. */
  description: string;
  /** Longer prose for the agent's Decision-logic card (`spec.explanation`). < 1200 chars. */
  explanation: string;
  paramSchema: GeneratedParamField[];
  /** The `decide()` source — a single arrow expression. */
  code: string;
}

export const CODE_PRESETS: CodePreset[] = [
  {
    id: "oracle-follow",
    name: "Oracle Follower",
    blurb: "Prices Up from how far the underlying sits above/below the strike, plus momentum drift.",
    description:
      "Directional model ported from the kit's ec-oracle-follow bot. Each cycle it reads the underlying BTC/ETH price and the contract's strike (opening price), measures the recent return over a short window, and turns 'how far is spot from the strike, next to a plausible move in the time left' into a fair Up probability. It only takes a side when that fair value differs from the market by more than a set edge, and it sits out markets whose strike it can't read (longer intervals).",
    explanation:
      "fair Up = 0.5 + 0.5·tanh(sqrt(2/pi)·z), where z = (moneyness + drift) / scale, moneyness = (spot - strike) / strike, drift = windowReturn·sqrt(horizons), scale = expectedMove·sqrt(horizons), and horizons = secondsToExpiry / (lookbackCandles·60) — the return window and the horizon share one length, so the sqrt(horizons) diffusive scaling stays meaningful. Abstains unless the strike, underlying and candles are available and |fair - market| >= minEdge.",
    paramSchema: [
      { key: "lookbackCandles", label: "Lookback candles", type: "number", default: 10, min: 2, max: 60, step: 1, help: "1-minute closes used both to measure the return and to size the horizon window." },
      { key: "expectedMove", label: "Expected move", type: "number", default: 0.0015, min: 0.0001, max: 0.05, step: 0.0001, help: "Fractional underlying move treated as one 'full' move over the window (OF_EXPECTED_MOVE)." },
      { key: "minEdge", label: "Min edge vs market", type: "number", default: 0.03, min: 0, max: 0.3, step: 0.005, help: "Required gap between the model's Up probability and the market mid before acting (OF_EDGE)." },
    ],
    code: `(m, p, lib) => {
  if (m.strike === null || m.underlying === null || m.yesMid === null) return null;
  const closes = m.underlying.candles.map((k) => k[4]).filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  const lookback = Math.max(1, Math.floor(p.lookbackCandles));
  if (closes.length < lookback + 1) return null;
  const nowClose = closes[closes.length - 1];
  const pastClose = closes[closes.length - 1 - lookback];
  const r = lib.pctChange(pastClose, nowClose);
  if (!Number.isFinite(r)) return null;
  const horizons = Math.max(m.secondsToExpiry / (lookback * 60), 0.05);
  const rootH = Math.sqrt(horizons);
  const moneyness = (m.underlying.price - m.strike) / m.strike;
  const scale = p.expectedMove * rootH;
  if (!(scale > 0)) return null;
  const z = (moneyness + r * rootH) / scale;
  const pUp = lib.clamp(0.5 + 0.5 * Math.tanh(0.7978845608 * z), 0.05, 0.95);
  if (Math.abs(pUp - m.yesMid) < p.minEdge) return null;
  const confidence = lib.clamp(0.5 + 0.5 * Math.tanh(Math.abs(z) / 3), 0.1, 0.95);
  const dir = pUp > m.yesMid ? "Up" : "Down";
  const reasoning = "Oracle Follower: underlying " + m.underlying.price.toFixed(2) + " vs strike " +
    m.strike.toFixed(2) + " (moneyness " + (moneyness * 100).toFixed(2) + "%), " + lookback +
    "-candle return " + (r * 100).toFixed(2) + "%, " + horizons.toFixed(2) + " windows left, z=" +
    z.toFixed(2) + " -> model P(up) " + pUp.toFixed(3) + " vs market " + m.yesMid.toFixed(3) +
    ", lean " + dir + ".";
  return { fairUpProbability: pUp, confidence: confidence, reasoning: reasoning };
}`,
  },
  {
    id: "momentum",
    name: "Underlying Momentum",
    blurb: "Rides a clean trend in the underlying — tilts the market mid in the trend's direction.",
    description:
      "Trend-following model ported from the kit's momentum bot. Each cycle it splits the last N one-minute underlying closes into an older half and a recent half; momentum is the percentage gap between their averages. Past a threshold it leans the market's implied Up probability in the trend's direction, scaled by a sensitivity knob. Optionally it only acts when price is also at a new window extreme.",
    explanation:
      "momentum = (mean(recent half) - mean(older half)) / mean(older half) over the last windowSize underlying closes. If |momentum| >= entryMomentum, tilt = sign(sensitivity·momentum)·min(|sensitivity·momentum|, room-to-rail) — the tilt is capped by the distance to 0.05/0.95 so a big move can't flip the side near a rail. fair Up = clamp(marketMid + tilt). Abstains while the window is short, momentum is weak, or (with breakout only) price isn't at the window extreme.",
    paramSchema: [
      { key: "windowSize", label: "Window (candles)", type: "number", default: 20, min: 4, max: 120, step: 1, help: "How many 1-minute closes the momentum split uses (MOM_WINDOW_SIZE)." },
      { key: "entryMomentum", label: "Entry momentum", type: "number", default: 0.008, min: 0.0005, max: 0.1, step: 0.0005, help: "Minimum |recent-older|/older before taking a side (MOM_ENTRY_MOMENTUM)." },
      { key: "sensitivity", label: "Sensitivity", type: "number", default: 20, min: 1, max: 80, step: 1, help: "Probability tilt per unit of return (approx OF_SENSITIVITY)." },
      { key: "breakoutOnly", label: "Breakout only", type: "boolean", default: false, help: "Also require the last close to be a window extreme in the trade direction." },
    ],
    code: `(m, p, lib) => {
  if (m.underlying === null || m.yesMid === null) return null;
  const win = Math.max(4, Math.floor(p.windowSize));
  const closes = m.underlying.candles.map((k) => k[4]).filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  if (closes.length < win) return null;
  const series = closes.slice(-win);
  const half = Math.floor(series.length / 2);
  if (half < 1) return null;
  const mOld = lib.mean(series.slice(0, half));
  const mNew = lib.mean(series.slice(half));
  if (!Number.isFinite(mOld) || !Number.isFinite(mNew) || !(mOld > 0)) return null;
  const mom = (mNew - mOld) / mOld;
  if (!Number.isFinite(mom) || Math.abs(mom) < p.entryMomentum) return null;
  const lastClose = series[series.length - 1];
  if (p.breakoutOnly) {
    if (mom > 0 && !(lastClose >= Math.max(...series) * 0.999)) return null;
    if (mom < 0 && !(lastClose <= Math.min(...series) * 1.001)) return null;
  }
  const raw = p.sensitivity * mom;
  const room = raw > 0 ? 0.95 - m.yesMid : m.yesMid - 0.05;
  const tilt = Math.sign(raw) * Math.min(Math.abs(raw), Math.max(room, 0));
  const pUp = lib.clamp(m.yesMid + tilt, 0.05, 0.95);
  if (Math.abs(pUp - m.yesMid) < 0.005) return null;
  const confidence = lib.clamp(0.4 + Math.min(Math.abs(mom) / (p.entryMomentum * 3), 1) * 0.5, 0.1, 0.9);
  const dir = mom > 0 ? "Up" : "Down";
  const reasoning = "Underlying Momentum: " + win + "-candle window, recent avg " + mNew.toFixed(2) +
    " vs older avg " + mOld.toFixed(2) + " -> momentum " + (mom * 100).toFixed(2) + "%" +
    (p.breakoutOnly ? " (breakout confirmed)" : "") + "; tilt market " + m.yesMid.toFixed(3) +
    " by " + (tilt >= 0 ? "+" : "") + tilt.toFixed(3) + " -> P(up) " + pUp.toFixed(3) + ", lean " + dir + ".";
  return { fairUpProbability: pUp, confidence: confidence, reasoning: reasoning };
}`,
  },
  {
    id: "mean-reversion",
    name: "Oversold Bounce",
    blurb: "RSI + Bollinger on the underlying: fades statistically stretched moves, both directions.",
    description:
      "Contrarian model ported from the kit's mean-reversion bot (RSI + Bollinger Bands), made two-sided for event contracts. When the underlying is oversold (low RSI and at/below the lower band) it leans Up; when it's overbought (high RSI and at/above the upper band) it leans Down; otherwise it stays flat. It sits out clean trends by construction.",
    explanation:
      "RSI is Wilder's over the last rsiPeriod one-minute close-to-close changes. Bands are sma(closes, bbPeriod) +/- bbMult·stddev. Oversold (RSI <= rsiOversold and last close <= lower band) -> fair Up = marketMid + revertStrength. Overbought (RSI >= 100 - rsiOversold and last close >= upper band) -> fair Up = marketMid - revertStrength. Abstains otherwise, or with too few candles.",
    paramSchema: [
      { key: "rsiPeriod", label: "RSI period", type: "number", default: 14, min: 2, max: 50, step: 1 },
      { key: "bbPeriod", label: "Bollinger period", type: "number", default: 20, min: 2, max: 60, step: 1 },
      { key: "bbMult", label: "Bollinger width (sd)", type: "number", default: 2, min: 0.5, max: 4, step: 0.1 },
      { key: "rsiOversold", label: "Oversold RSI", type: "number", default: 30, min: 5, max: 45, step: 1, help: "Overbought mirror is 100 minus this." },
      { key: "revertStrength", label: "Revert strength", type: "number", default: 0.05, min: 0.005, max: 0.3, step: 0.005, help: "How far to push fair Up off the market mid." },
    ],
    code: `(m, p, lib) => {
  if (m.underlying === null || m.yesMid === null) return null;
  const closes = m.underlying.candles.map((k) => k[4]).filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  const rsiN = Math.max(2, Math.floor(p.rsiPeriod));
  const bbN = Math.max(2, Math.floor(p.bbPeriod));
  if (closes.length < Math.max(rsiN + 1, bbN)) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - rsiN; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const avgGain = gain / rsiN, avgLoss = loss / rsiN;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const mid = lib.sma(closes, bbN);
  const sd = lib.stddev(closes.slice(-bbN));
  if (!Number.isFinite(mid) || !Number.isFinite(sd)) return null;
  const lower = mid - p.bbMult * sd, upper = mid + p.bbMult * sd;
  const lastClose = closes[closes.length - 1];
  let pUp, side;
  if (rsi <= p.rsiOversold && lastClose <= lower) {
    pUp = lib.clamp(m.yesMid + p.revertStrength, 0.05, 0.95);
    side = "oversold (RSI " + rsi.toFixed(0) + ", close below lower band) -> bounce, lean Up";
  } else if (rsi >= 100 - p.rsiOversold && lastClose >= upper) {
    pUp = lib.clamp(m.yesMid - p.revertStrength, 0.05, 0.95);
    side = "overbought (RSI " + rsi.toFixed(0) + ", close above upper band) -> fade, lean Down";
  } else {
    return null;
  }
  if (Math.abs(pUp - m.yesMid) < 0.005) return null;
  const confidence = lib.clamp(0.45 + Math.abs(rsi - 50) / 120, 0.1, 0.9);
  return { fairUpProbability: pUp, confidence: confidence,
    reasoning: "Oversold Bounce: " + side + " (fair P(up) " + pUp.toFixed(3) + " vs market " + m.yesMid.toFixed(3) + ")." };
}`,
  },
  {
    id: "range-fade",
    name: "Range Fader",
    blurb: "When the implied probability sits in a tight band near 50%, fades wiggles back to centre.",
    description:
      "Balanced-market model built from the prose 'Range Fader' preset and the kit's laddering bot. It only engages when the market's implied Up probability has been hovering in a narrow band close to 0.5 with a two-sided book. Then it treats a move away from the band centre as noise and prices fair Up back toward that centre. It steps aside the moment the probability breaks out of its range or the book goes one-sided.",
    explanation:
      "Over the implied-probability history: centre = mean, width = stddev. Engages only when width <= maxBandWidth and |centre - 0.5| <= centerTolerance and the book is two-sided. If |mid - centre| >= minDeviation, fair Up = clamp(centre - (mid - centre)·reversionGain) — pulled back across the centre. Abstains otherwise.",
    paramSchema: [
      { key: "minSamples", label: "Min history", type: "number", default: 20, min: 5, max: 120, step: 1, help: "Implied-probability samples required before engaging." },
      { key: "maxBandWidth", label: "Max band width (sd)", type: "number", default: 0.06, min: 0.01, max: 0.2, step: 0.005, help: "Stddev of recent probability above which it's a breakout, not a range." },
      { key: "centerTolerance", label: "Centre tolerance", type: "number", default: 0.1, min: 0.02, max: 0.25, step: 0.01, help: "How far the band centre may sit from 0.5." },
      { key: "minDeviation", label: "Min deviation", type: "number", default: 0.015, min: 0.002, max: 0.1, step: 0.002, help: "Gap from centre before fading it." },
      { key: "reversionGain", label: "Reversion gain", type: "number", default: 0.5, min: 0.1, max: 1, step: 0.05, help: "Share of the deviation to price back across the centre." },
    ],
    code: `(m, p, lib) => {
  if (m.yesMid === null || m.spread === null) return null;
  const hist = (Array.isArray(m.history) && m.history.length >= p.minSamples) ? m.history
    : (Array.isArray(m.recentHistory) && m.recentHistory.length >= p.minSamples) ? m.recentHistory
    : null;
  if (hist === null) return null;
  const center = lib.mean(hist);
  const width = lib.stddev(hist);
  if (!Number.isFinite(center) || !Number.isFinite(width)) return null;
  if (width > p.maxBandWidth) return null;
  if (Math.abs(center - 0.5) > p.centerTolerance) return null;
  const dev = m.yesMid - center;
  if (Math.abs(dev) < p.minDeviation) return null;
  const pUp = lib.clamp(center - dev * p.reversionGain, 0.05, 0.95);
  if (Math.abs(pUp - m.yesMid) < 0.005) return null;
  const confidence = lib.clamp(0.4 + Math.min(Math.abs(dev) / (width + 1e-9), 3) / 6, 0.1, 0.85);
  const dir = pUp > m.yesMid ? "Up" : "Down";
  return { fairUpProbability: pUp, confidence: confidence,
    reasoning: "Range Fader: mid " + m.yesMid.toFixed(3) + " deviates " + (dev * 100).toFixed(2) +
      "pp from a tight band centered " + center.toFixed(3) + " +/- " + width.toFixed(3) +
      " -> revert toward centre, lean " + dir + "." };
}`,
  },
];

export function getCodePreset(id: string): CodePreset | undefined {
  return CODE_PRESETS.find((p) => p.id === id);
}

/** The default knob values for a preset, ready to store as `generated_params`. */
export function paramsForCodePreset(p: CodePreset): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const f of p.paramSchema) out[f.key] = f.default;
  return out;
}

/** The `generated_spec` to store for an agent seeded from this preset. */
export function specForCodePreset(p: CodePreset): GeneratedStrategySpec {
  return {
    explanation: p.explanation.slice(0, 1200),
    blurb: p.blurb.slice(0, 120),
    paramSchema: p.paramSchema,
    sourceDescription: p.description,
    provider: "preset",
    model: null,
    presetId: p.id,
  };
}

// ── Health check — shared by POST /api/agents and the test script ───────────

function smokeMarkets(): CodeMarketView[] {
  const now = Math.floor(Date.now() / 1000);
  const full: CodeMarketView = {
    marketId: "0x" + "11".repeat(32),
    symbol: "BTC-0-03SEP26-1700/tUSDC",
    asset: "BTC",
    question: "BTC closes at or above its opening price",
    intervalSec: 3600,
    secondsToExpiry: 1500,
    tradingStart: now - 2100,
    expiresAt: now + 1500,
    yesMid: 0.54,
    bestYesBid: 0.53,
    bestYesAsk: 0.55,
    spread: 0.02,
    recentHistory: [0.5, 0.51, 0.52, 0.53, 0.54, 0.53, 0.54],
    history: Array.from({ length: 60 }, (_, i) => 0.5 + Math.sin(i / 7) * 0.03),
    strike: 77000,
    underlying: {
      price: 77320,
      ema: 77250,
      change24hPct: 0.4,
      high24h: 77800,
      low24h: 76500,
      candles: Array.from({ length: 120 }, (_, i) => {
        const c = 77000 + Math.sin(i / 9) * 120 + i * 2.5;
        return [Date.now() - (120 - i) * 60_000, c - 3, c + 9, c - 9, c, 10] as [number, number, number, number, number, number];
      }),
    },
  };
  const bare: CodeMarketView = {
    ...full,
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
  const noStrike: CodeMarketView = { ...full, marketId: "0x" + "33".repeat(32), strike: null };
  return [full, bare, noStrike];
}

const healthy = new Set<string>();

/** Static gate + param-schema sanity + a synthetic sandbox run. Memoized per
 *  preset id per process (one worker spawn, ever, on success). */
export async function validateCodePreset(p: CodePreset): Promise<{ ok: true } | { ok: false; error: string }> {
  if (healthy.has(p.id)) return { ok: true };
  const rej = staticReject(p.code);
  if (rej) return { ok: false, error: `staticReject: ${rej}` };
  for (const f of p.paramSchema) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key)) return { ok: false, error: `bad param key ${f.key}` };
    if (f.type === "number" ? typeof f.default !== "number" : typeof f.default !== "boolean") {
      return { ok: false, error: `param ${f.key}: default is not a ${f.type}` };
    }
  }
  const run = await runStrategyCode(p.code, paramsForCodePreset(p), smokeMarkets(), { timeoutMs: 2000 });
  if (!run.ok) return { ok: false, error: `${run.kind}: ${run.message}` };
  healthy.add(p.id);
  return { ok: true };
}

// Fail fast at boot if a hand-written artifact trips the sandbox's static gate.
for (const p of CODE_PRESETS) {
  const rej = staticReject(p.code);
  if (rej) throw new Error(`code preset "${p.id}" is invalid: ${rej}`);
}
