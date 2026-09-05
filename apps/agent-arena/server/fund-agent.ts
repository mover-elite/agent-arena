// Funding an agent's wallet: gas drip from the treasury + a faucet mint.
// This is now an EXPLICIT action — the owner triggers it from the agent page,
// it never happens on its own on some cycle. The only exception is the
// platform-seeded flagships (no owner to click), which the engine funds on
// their first cycle. A per-hour treasury cap is the only gate — it guards
// against a burst draining the gas wallet, it does not hold an agent hostage.

import { provisionAgentWallet } from "./agent-wallet.js";
import { getAgentWalletPrivateKey, isWalletFunded, markWalletFunded } from "./agents-store.js";
import { hit } from "./rate-limit.js";
import type { Agent } from "./types.js";

const log = (s: string) => console.log(`${new Date().toISOString()} [fund] ${s}`);

const MAX_AGENT_FUNDS_PER_HOUR = Number(process.env.MAX_AGENT_FUNDS_PER_HOUR ?? 20);

export interface FundResult {
  ok: boolean;
  error?: string;
  alreadyFunded?: boolean;
}

/** Provision `agent`'s wallet (idempotent — a no-op if already funded). */
export async function fundAgent(agent: Agent): Promise<FundResult> {
  if (isWalletFunded(agent.id)) return { ok: true, alreadyFunded: true };

  const rl = hit("treasury:fund", MAX_AGENT_FUNDS_PER_HOUR, 3_600_000);
  if (!rl.ok) {
    return { ok: false, error: `treasury is funding too many agents this hour (max ${MAX_AGENT_FUNDS_PER_HOUR}) — try again in ${Math.ceil(rl.retryAfterMs / 60000)}m` };
  }

  const privateKey = getAgentWalletPrivateKey(agent.id);
  if (!privateKey) return { ok: false, error: "agent has no wallet key on record" };

  const result = await provisionAgentWallet(privateKey, agent.walletAddress);
  if (!result.ok) {
    log(`${agent.name}: funding failed — ${result.error}`);
    return { ok: false, error: result.error };
  }
  markWalletFunded(agent.id);
  log(`${agent.name}: wallet funded, trading from ${agent.walletAddress}`);
  return { ok: true };
}
