import { GoogleGenAI } from "@google/genai";
import type { Agent, LlmMarketCall, MarketSnapshot } from "../types.js";
import { buildPrompt, CALLS_JSON_SCHEMA, systemInstruction, validateCalls } from "./shared.js";

const DEFAULT_MODEL = "gemini-3.7-flash";

export async function decideWithGemini(
  agent: Agent,
  snapshots: MarketSnapshot[],
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<LlmMarketCall[]> {
  if (snapshots.length === 0) return [];
  try {
    const client = new GoogleGenAI({ apiKey });
    const interaction = await client.interactions.create({
      model,
      input: buildPrompt(snapshots),
      system_instruction: systemInstruction(agent.strategyPrompt),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: CALLS_JSON_SCHEMA,
      },
      // This task is small and fully data-grounded (a few numbers + a short
      // sentence per market, from data already handed to the model) — no
      // reason to pay for the model's default higher thinking budget.
      generation_config: {
        max_output_tokens: 1024,
        thinking_level: "low",
      },
    });

    const text = interaction.output_text;
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return validateCalls(parsed, snapshots);
  } catch (e) {
    console.error(`${new Date().toISOString()} [llm:gemini] error for agent ${agent.id}: ${(e as Error).message}`);
    return [];
  }
}
