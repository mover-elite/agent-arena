// Provider + credential dispatcher. Every agent reasons with its OWN key —
// there is no shared/account fallback:
//   • a user-owned agent uses the key set on that agent (getAgentLlmCredentials);
//     with none it simply can't reason (fails closed to HOLD).
//   • the seeded flagship agents (no owner) use the platform `.env` key.
// So credit usage is isolated per agent: one agent's rate-limit or billing
// problem never blocks another's, not even two owned by the same person.
//
// Both providers fail closed to an empty array internally on any error
// (auth, parse, network), which the caller (agent-engine.ts) treats as "no
// call this cycle" = HOLD.

import { decideWithAnthropic } from "./llm-providers/anthropic.js";
import { decideWithGemini } from "./llm-providers/gemini.js";
import { getAgentLlmCredentials } from "./agents-store.js";
import type { Agent, LlmCredentials, LlmCredentialsMeta, LlmMarketCall, MarketSnapshot, LlmProviderName } from "./types.js";

export function currentProvider(): LlmProviderName {
  return (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase() === "gemini" ? "gemini" : "anthropic";
}

function platformCredentials(): LlmCredentials | null {
  const provider = currentProvider();
  const apiKey = provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = provider === "gemini" ? process.env.GEMINI_MODEL : process.env.ANTHROPIC_MODEL;
  return { provider, apiKey, model };
}

function resolveCredentials(agent: Agent): LlmCredentials | null {
  const own = getAgentLlmCredentials(agent.id);
  if (own) return own;
  // No owner = a seeded flagship: the only agents that use the platform key.
  if (!agent.ownerUserId) return platformCredentials();
  return null; // user-owned with no key of its own → can't reason
}

/** Same resolution as `resolveCredentials`, but returns only the provider +
 *  where it came from — no key. For the UI / API to show how an agent reasons. */
export function resolveCredentialsMeta(agent: Agent): LlmCredentialsMeta {
  if (agent.hasOwnLlmKey && agent.ownLlmProvider) return { provider: agent.ownLlmProvider, source: "agent" };
  if (!agent.ownerUserId) {
    const platform = platformCredentials();
    if (platform) return { provider: platform.provider, source: "platform" };
  }
  return { provider: null, source: "none" };
}

export async function decideForAgent(agent: Agent, snapshots: MarketSnapshot[]): Promise<LlmMarketCall[]> {
  const creds = resolveCredentials(agent);
  if (!creds) return []; // no key configured — fails closed to HOLD, same as any other LLM error
  return creds.provider === "gemini"
    ? decideWithGemini(agent, snapshots, creds.apiKey, creds.model)
    : decideWithAnthropic(agent, snapshots, creds.apiKey, creds.model);
}
