import Anthropic from "@anthropic-ai/sdk";
import type { Agent, LlmMarketCall, MarketSnapshot } from "../types.js";
import { buildPrompt, CALLS_JSON_SCHEMA, systemInstruction, validateCalls } from "./shared.js";

const DEFAULT_MODEL = "claude-sonnet-5";

const DECISION_TOOL: Anthropic.Tool = {
  name: "record_market_calls",
  description: "Record a fair Up-probability estimate for each market you were shown.",
  input_schema: CALLS_JSON_SCHEMA as unknown as Anthropic.Tool["input_schema"],
};

export async function decideWithAnthropic(
  agent: Agent,
  snapshots: MarketSnapshot[],
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<LlmMarketCall[]> {
  if (snapshots.length === 0) return [];
  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemInstruction(agent.strategyPrompt),
      messages: [{ role: "user", content: buildPrompt(snapshots) }],
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "record_market_calls" },
    });

    const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) return [];
    return validateCalls(toolUse.input, snapshots);
  } catch (e) {
    console.error(`${new Date().toISOString()} [llm:anthropic] error for agent ${agent.id}: ${(e as Error).message}`);
    return [];
  }
}
