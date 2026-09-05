// The one-off "write me a decide() function" LLM call. Same provider split and
// structured-output pattern as anthropic.ts / gemini.ts (forced tool / JSON
// schema, construct client per call, fail closed), just a different task and a
// bigger token budget. Consumed by strategy-gen.ts, which adds validation +
// one retry.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { LIB_SIGNATURES } from "../strategy-lib.js";

/** Raw, unvalidated shape the model is asked to emit. */
export interface RawGeneratedStrategy {
  name: string;
  blurb: string;
  explanation: string;
  code: string;
  params: Record<string, number | boolean>;
  paramSchema: Array<{
    key: string;
    label: string;
    type: "number" | "boolean";
    default: number | boolean;
    min?: number;
    max?: number;
    step?: number;
    help?: string;
  }>;
}

export const GEN_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short agent name, ≤ 40 chars." },
    blurb: { type: "string", description: "One line describing the strategy, ≤ 90 chars." },
    explanation: { type: "string", description: "2-4 sentences a non-programmer can follow: what signal it reads and when it bets Up vs Down." },
    code: {
      type: "string",
      description:
        "A single pure arrow-function expression `(market, params, lib) => {...}` — no name, no `const fn =`, no semicolon-terminated statement wrapper. Sync only. Returns { fairUpProbability, confidence, reasoning } or null.",
    },
    params: { type: "object", description: "Flat map of the tunable knobs to their default values (numbers/booleans only)." },
    paramSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          type: { type: "string", enum: ["number", "boolean"] },
          default: {},
          min: { type: "number" },
          max: { type: "number" },
          step: { type: "number" },
          help: { type: "string" },
        },
        required: ["key", "label", "type", "default"],
      },
    },
  },
  required: ["name", "blurb", "explanation", "code", "params", "paramSchema"],
} as const;

const CONTRACT = `You are writing the decision logic for an automated trading agent on DreamDEX Event Contracts
(Somnia). Each market is a binary "Up" contract: it settles YES if an asset (BTC or ETH) closes at
or above its opening price by an expiry. The YES side trades in (0,1) and IS the market's implied
probability of Up.

Emit ONE pure JavaScript arrow function, the value of "code":

  (market, params, lib) => {
    // ... synchronous logic only ...
    return { fairUpProbability: <0..1 exclusive>, confidence: <0..1 exclusive>, reasoning: "<one sentence>" };
    // or: return null;   // no opinion this market this cycle -> the agent HOLDs
  }

The engine compares your fairUpProbability to the market's implied probability (market.yesMid):
a positive gap => it may BUY Up, negative => BUY Down, small gap or low confidence => HOLD. So your
job is only to estimate a fair Up probability and how sure you are. Do NOT place orders, size
positions, or reference wallets — the engine does all execution and risk gating.

market (all already computed, read-only):
  marketId: string
  symbol, asset ("BTC"|"ETH"), question: string
  intervalSec: number            // window length
  secondsToExpiry: number
  tradingStart, expiresAt: number // unix seconds
  yesMid: number | null          // implied P(Up), (0,1); null if the book is one-sided/empty
  bestYesBid, bestYesAsk, spread: number | null
  recentHistory: number[]        // yesMid samples, oldest first, up to 20 (this cycle's snapshot)
  history: number[]              // yesMid samples, oldest first, up to 360 (process-wide)
  strike: number | null          // the underlying's price when the window opened (what "Up" beats); null if unknown
  underlying: {                  // the REAL BTC/ETH spot feed; null if unavailable this cycle
    price, ema: number
    change24hPct, high24h, low24h: number | null
    candles: [tsMs, open, high, low, close, volume][]   // 1-minute OHLCV, oldest first, ~150
  } | null

lib (pure helpers — use these instead of hand-rolling math):
${LIB_SIGNATURES}

params: a flat object of your tunable knobs, passed in every cycle. EVERY key you read from
\`params\` in \`code\` MUST appear in \`params\` (with a sensible default) AND in \`paramSchema\`
(with label, type, default, and min/max where numeric).

HARD RULES for \`code\`:
  - Pure and SYNCHRONOUS. No async/await. No side effects.
  - Forbidden identifiers: require, import, process, globalThis, eval, Function, fetch, XMLHttpRequest, WebSocket.
  - No unbounded loops: never \`while(true)\` or \`for(;;)\`. Only iterate the bounded arrays
    market.history / market.recentHistory / market.underlying.candles.
  - Always guard: \`market.yesMid\`, \`market.strike\`, and \`market.underlying\` can be null.
    If you can't form a view, \`return null\`.
  - fairUpProbability and confidence must be strictly inside (0,1) — clamp with lib.clamp(x, 0.02, 0.98).
  - reasoning: one short sentence citing the number that drove the call.
  - The whole function must be under 6000 characters.`;

const EXAMPLES = `Example 1 — underlying momentum via candle closes:
{
  "name": "Candle Momentum",
  "blurb": "Bets with a clean short-term trend in the underlying's 1m closes.",
  "explanation": "Fits a line to the last N one-minute closes of BTC/ETH. If the slope is clearly up it leans the fair Up probability above the market; clearly down, below. Flat or missing data -> no opinion.",
  "code": "(market, params, lib) => { const u = market.underlying; if (!u || u.candles.length < params.lookback || market.yesMid == null) return null; const closes = u.candles.slice(-params.lookback).map(c => c[4]); const slope = lib.linregSlope(closes); const norm = slope / (lib.mean(closes) || 1); if (!Number.isFinite(norm) || Math.abs(norm) < params.minSlope) return null; const push = lib.clamp(norm * params.gain, -params.maxPush, params.maxPush); const fair = lib.clamp(market.yesMid + push, 0.02, 0.98); return { fairUpProbability: fair, confidence: lib.clamp(0.4 + Math.abs(norm) * params.confGain, 0.02, 0.9), reasoning: 'close slope ' + norm.toFixed(5) + ' over ' + params.lookback + ' candles' }; }",
  "params": { "lookback": 20, "minSlope": 0.00002, "gain": 6, "maxPush": 0.15, "confGain": 2000 },
  "paramSchema": [
    { "key": "lookback", "label": "Candles to fit", "type": "number", "default": 20, "min": 5, "max": 120, "step": 1 },
    { "key": "minSlope", "label": "Min normalized slope", "type": "number", "default": 0.00002, "min": 0, "max": 0.001, "step": 0.00001 },
    { "key": "gain", "label": "Slope -> probability gain", "type": "number", "default": 6, "min": 1, "max": 40, "step": 1 },
    { "key": "maxPush", "label": "Max deviation from market", "type": "number", "default": 0.15, "min": 0.02, "max": 0.4, "step": 0.01 },
    { "key": "confGain", "label": "Confidence gain", "type": "number", "default": 2000, "min": 100, "max": 10000, "step": 100 }
  ]
}

Example 2 — distance from the strike, with a null guard:
{
  "name": "Strike Drift",
  "blurb": "The further price sits above/below the opening price, the more decided the outcome.",
  "explanation": "Compares the current underlying price to the window's opening price (the level 'Up' must beat). A wide gap late in the window means the outcome is likely settled, so it pushes toward 1 (above) or 0 (below); near the strike it stays close to the market.",
  "code": "(market, params, lib) => { const u = market.underlying; if (!u || market.strike == null || market.yesMid == null) return null; const gap = lib.pctChange(market.strike, u.price); if (!Number.isFinite(gap)) return null; const timeFrac = lib.clamp(1 - market.secondsToExpiry / Math.max(market.intervalSec, 1), 0, 1); const conviction = lib.clamp(Math.abs(gap) / params.fullGap, 0, 1) * (params.timeWeight * timeFrac + (1 - params.timeWeight)); const target = gap >= 0 ? 1 : 0; const fair = lib.clamp(market.yesMid + (target - market.yesMid) * conviction, 0.02, 0.98); return { fairUpProbability: fair, confidence: lib.clamp(0.35 + conviction * 0.5, 0.02, 0.9), reasoning: 'price ' + (gap * 100).toFixed(2) + '% vs strike, ' + (timeFrac * 100).toFixed(0) + '% through window' }; }",
  "params": { "fullGap": 0.004, "timeWeight": 0.6 },
  "paramSchema": [
    { "key": "fullGap", "label": "Gap for full conviction", "type": "number", "default": 0.004, "min": 0.0005, "max": 0.03, "step": 0.0005, "help": "Fractional move from strike that counts as 'decided'." },
    { "key": "timeWeight", "label": "Weight on time-to-expiry", "type": "number", "default": 0.6, "min": 0, "max": 1, "step": 0.05 }
  ]
}`;

function systemPrompt(): string {
  return `${CONTRACT}\n\n${EXAMPLES}\n\nReturn ONLY the JSON object. The "code" field is a string containing the arrow function.`;
}

export async function codegenWithAnthropic(
  description: string,
  apiKey: string,
  model: string,
  priorError?: string,
): Promise<RawGeneratedStrategy> {
  const client = new Anthropic({ apiKey });
  const user = priorError
    ? `Your previous attempt failed validation: ${priorError}\nReturn the entire artifact again, fixed.\n\nStrategy description:\n${description}`
    : `Strategy description:\n${description}`;
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt(),
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: "emit_strategy",
        description: "Emit the generated trading strategy.",
        input_schema: GEN_JSON_SCHEMA as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "emit_strategy" },
  });
  const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("model returned no tool call");
  return toolUse.input as RawGeneratedStrategy;
}

export async function codegenWithGemini(
  description: string,
  apiKey: string,
  model: string,
  priorError?: string,
): Promise<RawGeneratedStrategy> {
  const client = new GoogleGenAI({ apiKey });
  const input = priorError
    ? `Your previous attempt failed validation: ${priorError}\nReturn the entire artifact again, fixed.\n\nStrategy description:\n${description}`
    : `Strategy description:\n${description}`;
  const interaction = await client.interactions.create({
    model,
    input,
    system_instruction: systemPrompt(),
    response_format: { type: "text", mime_type: "application/json", schema: GEN_JSON_SCHEMA },
    generation_config: { max_output_tokens: 4096, thinking_level: "low" },
  });
  const text = interaction.output_text;
  if (!text) throw new Error("model returned no text");
  return JSON.parse(text) as RawGeneratedStrategy;
}
