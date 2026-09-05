// Turns a plain-English strategy description into an executable, validated
// `decide()` artifact. One LLM call (+ at most one retry). Called from
// agent-engine.ts `ensureCodeGenerated` (first cycle) and the `/regenerate`
// endpoint.

import { runStrategyCode, staticReject } from "./code-runner.js";
import { codegenWithAnthropic, codegenWithGemini, type RawGeneratedStrategy } from "./llm-providers/codegen.js";
import type { CodeMarketView, GeneratedParamField, GeneratedStrategySpec, LlmProviderName } from "./types.js";

export interface GenerateInput {
  description: string;
  name?: string;
  provider: LlmProviderName;
  apiKey: string;
  model?: string;
}

export interface GenerateOk {
  ok: true;
  code: string;
  params: Record<string, number | boolean>;
  spec: GeneratedStrategySpec;
}
export interface GenerateFail {
  ok: false;
  error: string;
}

const ANTHROPIC_DEFAULT = "claude-sonnet-5";
const GEMINI_DEFAULT = "gemini-3.7-flash";

// Two synthetic markets to smoke the generated code before it goes live: one
// fully populated, one with the nullable fields nulled to force the guard path.
// Exported so the code-preset test can smoke against the exact same shapes.
export function synthMarkets(): CodeMarketView[] {
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
    yesMid: 0.56,
    bestYesBid: 0.55,
    bestYesAsk: 0.57,
    spread: 0.02,
    recentHistory: [0.5, 0.51, 0.52, 0.54, 0.55, 0.56],
    history: Array.from({ length: 60 }, (_, i) => 0.45 + Math.sin(i / 6) * 0.04 + i * 0.0015),
    strike: 77000,
    underlying: {
      price: 77260,
      ema: 77245,
      change24hPct: 0.4,
      high24h: 77600,
      low24h: 76700,
      candles: Array.from({ length: 90 }, (_, i) => {
        const base = 77000 + Math.sin(i / 8) * 60 + i * 3;
        return [Date.now() - (90 - i) * 60_000, base, base + 8, base - 8, base + 4, 12] as [number, number, number, number, number, number];
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
  return [full, bare];
}

function validateParamSchema(raw: unknown): { schema: GeneratedParamField[]; params: Record<string, number | boolean> } | { error: string } {
  if (!Array.isArray(raw)) return { error: "paramSchema must be an array" };
  const schema: GeneratedParamField[] = [];
  const params: Record<string, number | boolean> = {};
  for (const f of raw) {
    if (typeof f !== "object" || f === null) return { error: "paramSchema entries must be objects" };
    const o = f as Record<string, unknown>;
    if (typeof o.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(o.key)) return { error: `bad param key ${JSON.stringify(o.key)}` };
    if (o.type !== "number" && o.type !== "boolean") return { error: `param ${o.key}: type must be "number" or "boolean"` };
    const def = o.default;
    if (o.type === "number" ? typeof def !== "number" || !Number.isFinite(def) : typeof def !== "boolean") {
      return { error: `param ${o.key}: default is not a ${o.type}` };
    }
    const field: GeneratedParamField = {
      key: o.key,
      label: typeof o.label === "string" && o.label ? o.label : o.key,
      type: o.type,
      default: def as number | boolean,
    };
    if (typeof o.min === "number") field.min = o.min;
    if (typeof o.max === "number") field.max = o.max;
    if (typeof o.step === "number") field.step = o.step;
    if (typeof o.help === "string") field.help = o.help;
    schema.push(field);
    params[field.key] = field.default;
  }
  return { schema, params };
}

/** Validate + smoke-test a raw model response. Exported so the generation call
 *  and the offline test can share the exact same acceptance logic. */
export async function finalizeRaw(
  raw: RawGeneratedStrategy,
  input: Pick<GenerateInput, "description" | "provider">,
  model: string,
): Promise<GenerateOk | GenerateFail> {
  if (typeof raw?.code !== "string" || typeof raw?.explanation !== "string") {
    return { ok: false, error: "model response missing code/explanation" };
  }
  const rej = staticReject(raw.code);
  if (rej) return { ok: false, error: `generated code rejected: ${rej}` };

  const ps = validateParamSchema(raw.paramSchema);
  if ("error" in ps) return { ok: false, error: ps.error };

  // Prefer the model's `params` values but only for keys declared in the schema.
  const params: Record<string, number | boolean> = { ...ps.params };
  if (raw.params && typeof raw.params === "object") {
    for (const [k, v] of Object.entries(raw.params)) {
      if (k in params && (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean")) params[k] = v;
    }
  }

  const dry = await runStrategyCode(raw.code, params, synthMarkets(), { timeoutMs: 1000 });
  if (!dry.ok) return { ok: false, error: `dry-run failed (${dry.kind}): ${dry.message}` };

  const spec: GeneratedStrategySpec = {
    explanation: String(raw.explanation).slice(0, 1200),
    blurb: (typeof raw.blurb === "string" && raw.blurb ? raw.blurb : String(raw.explanation)).slice(0, 120),
    paramSchema: ps.schema,
    sourceDescription: input.description,
    provider: input.provider,
    model,
  };
  return { ok: true, code: raw.code, params, spec };
}

async function attempt(input: GenerateInput, model: string, priorError?: string): Promise<GenerateOk | GenerateFail> {
  let raw: RawGeneratedStrategy;
  try {
    raw =
      input.provider === "gemini"
        ? await codegenWithGemini(input.description, input.apiKey, model, priorError)
        : await codegenWithAnthropic(input.description, input.apiKey, model, priorError);
  } catch (e) {
    return { ok: false, error: `generation call failed: ${(e as Error).message}` };
  }
  return finalizeRaw(raw, input, model);
}

export async function generateStrategy(input: GenerateInput): Promise<GenerateOk | GenerateFail> {
  const model = input.model?.trim() || (input.provider === "gemini" ? GEMINI_DEFAULT : ANTHROPIC_DEFAULT);
  const first = await attempt(input, model);
  if (first.ok) return first;
  const retry = await attempt(input, model, first.error);
  if (retry.ok) return retry;
  return { ok: false, error: retry.error };
}
