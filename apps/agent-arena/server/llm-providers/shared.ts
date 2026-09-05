// Prompt construction and response validation shared by every LLM provider
// (anthropic.ts, gemini.ts) — the part of llm-decide.ts that has nothing to
// do with which vendor's SDK is calling it.

import type { LlmMarketCall, MarketSnapshot } from "../types.js";

function marketBlock(s: MarketSnapshot): string {
  const history = s.recentHistory.map((p) => p.yesMid.toFixed(3)).join(" -> ") || "(no history yet)";
  return [
    `marketId: ${s.marketId}`,
    `symbol: ${s.symbol} (asset ${s.asset}, window ${s.intervalSec}s)`,
    `secondsToExpiry: ${Math.max(0, Math.round(s.secondsToExpiry))}`,
    `book: bestYesBid=${s.bestYesBid?.toFixed(3) ?? "-"} bestYesAsk=${s.bestYesAsk?.toFixed(3) ?? "-"} mid=${s.yesMid?.toFixed(3) ?? "-"}`,
    `recentYesMidHistory: ${history}`,
  ].join("\n  ");
}

export function buildPrompt(snapshots: MarketSnapshot[]): string {
  return [
    "You are trading DreamDEX Event Contracts on Somnia — binary Up/Down markets on BTC/ETH price.",
    "The market price IS the current implied probability of the Up (YES) outcome, in (0,1).",
    "For each market below, estimate your own fair Up probability, a confidence in that estimate, and give brief reasoning grounded in the data shown (order book, recent price history). Do not invent external information you were not given.",
    "",
    ...snapshots.map((s, i) => `Market ${i + 1}:\n  ${marketBlock(s)}`),
  ].join("\n");
}

export function systemInstruction(strategyPrompt: string): string {
  return `Strategy / personality for this agent: ${strategyPrompt}`;
}

function isFiniteProb(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1;
}

/** Filters a raw, untrusted parsed response down to calls that reference a
 *  market we actually showed the model and have sane numeric fields. Any
 *  entry that doesn't fully validate is dropped, never coerced. */
export function validateCalls(raw: unknown, snapshots: MarketSnapshot[]): LlmMarketCall[] {
  if (typeof raw !== "object" || raw === null) return [];
  const calls = (raw as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return [];

  const validMarketIds = new Set(snapshots.map((s) => s.marketId));
  const out: LlmMarketCall[] = [];
  for (const entry of calls) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.marketId !== "string" || !validMarketIds.has(c.marketId as `0x${string}`)) continue;
    if (!isFiniteProb(c.fairUpProbability) || !isFiniteProb(c.confidence)) continue;
    if (typeof c.reasoning !== "string" || c.reasoning.trim().length === 0) continue;
    out.push({
      marketId: c.marketId,
      fairUpProbability: c.fairUpProbability,
      confidence: c.confidence,
      reasoning: c.reasoning.trim(),
    });
  }
  return out;
}

/** JSON Schema for the structured response, shared verbatim by every
 *  provider that accepts plain JSON Schema (Gemini does; Anthropic's tool
 *  input_schema is JSON-Schema-shaped too, so this covers both). */
export const CALLS_JSON_SCHEMA = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "The exact marketId you were given for this market." },
          fairUpProbability: { type: "number", description: "Fair-value estimate the Up/YES side resolves true, in (0,1)." },
          confidence: { type: "number", description: "Confidence in this estimate, in (0,1)." },
          reasoning: { type: "string", description: "1-3 sentences: why this probability, referencing the order book / recent price action shown." },
        },
        required: ["marketId", "fairUpProbability", "confidence", "reasoning"],
      },
    },
  },
  required: ["calls"],
} as const;
