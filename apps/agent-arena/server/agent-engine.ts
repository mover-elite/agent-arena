// Per-agent orchestration for one cycle: shared market snapshots + the
// agent's own strategy prompt -> LLM calls -> risk gating -> a real trade on
// the agent's own dedicated testnet wallet, logged immediately either way.
// No simulated/paper path — every agent trades for real from the moment its
// wallet is funded (provisioned lazily right here, on its first eligible
// cycle, rather than at creation, so agent creation itself stays instant).

import { randomUUID } from "node:crypto";
import { decideForAgent } from "./llm-decide.js";
import { gateTrade, sizeTradeUsd } from "./risk.js";
import { executeLiveTrade, maybeClaimForAgent } from "./live-executor.js";
import { fundAgent } from "./fund-agent.js";
import { appendRecord } from "./decision-log.js";
import {
  getAgentLlmCredentials,
  getCodeGeneratedAt,
  getDailyPnlUsd,
  getGeneratedStrategy,
  getLastTradeAtMs,
  isWalletFunded,
  markCodeGenerated,
  openPosition,
  setCodeError,
  setGeneratedStrategy,
  setLastTradeAtMs,
} from "./agents-store.js";
import { buildCodeMarketViews } from "./code-market-view.js";
import { runStrategyCode } from "./code-runner.js";
import { generateStrategy } from "./strategy-gen.js";
import { commitReasoningAsync } from "./reasoning-registry.js";
import { needsFreshCall, recordCycle } from "./llm-cache.js";
import { checkBudget, recordCall } from "./llm-budget.js";
import type { Agent, DecisionRecord, LlmMarketCall, MarketSnapshot, RiskConfig } from "./types.js";

const log = (s: string) => console.log(`${new Date().toISOString()} [engine] ${s}`);
const dailyCapNoted = new Set<string>();

// Track ownerless flagships we've already tried to auto-fund this process, so a
// persistent failure (treasury empty) doesn't retry every single cycle.
const flagshipFundAttempted = new Set<string>();

/** Gate before an agent can trade. Funding is now the OWNER'S call, made from
 *  the agent page — an unfunded owned agent just sits idle until they fund it.
 *  The only auto-funding is for platform-seeded flagships (no owner to click),
 *  once per process. */
async function ensureFunded(agent: Agent): Promise<boolean> {
  if (isWalletFunded(agent.id)) return true;
  if (agent.ownerUserId) return false; // owner funds it explicitly
  if (flagshipFundAttempted.has(agent.id)) return false;
  flagshipFundAttempted.add(agent.id);
  const r = await fundAgent(agent);
  if (!r.ok) {
    log(`${agent.name}: flagship auto-fund failed — ${r.error}`);
    flagshipFundAttempted.delete(agent.id); // let a later cycle retry once the treasury is topped up
    return false;
  }
  return true;
}

/** `"code"` agents: write the decision function on the first eligible cycle
 *  (mirrors ensureFunded). One LLM call, ever — then the sandbox runs for free.
 *  On failure the agent parks with a visible `code_error` and does NOT retry the
 *  costly call every cycle; `/regenerate` clears it. No-op for `"llm"` agents. */
async function ensureCodeGenerated(agent: Agent): Promise<boolean> {
  if (agent.strategyKind !== "code") return true;
  if (getCodeGeneratedAt(agent.id)) return true;
  if (agent.codeError) return false;
  const creds = getAgentLlmCredentials(agent.id);
  if (!creds) {
    setCodeError(agent.id, "no LLM key available to generate strategy code");
    return false;
  }
  log(`${agent.name}: generating decision code from its description…`);
  const r = await generateStrategy({
    description: agent.strategyPrompt,
    name: agent.name,
    provider: creds.provider,
    apiKey: creds.apiKey,
    model: creds.model,
  });
  if (!r.ok) {
    setCodeError(agent.id, r.error);
    log(`${agent.name}: codegen failed — ${r.error}`);
    return false;
  }
  setGeneratedStrategy(agent.id, { code: r.code, params: r.params, spec: r.spec });
  markCodeGenerated(agent.id);
  log(`${agent.name}: decision code ready (${r.spec.paramSchema.length} params)`);
  return true;
}

/** Every watched market is inside this agent's trade cooldown → it couldn't
 *  act on a fresh read anyway, so don't pay for one. */
function allMarketsInCooldown(agentId: string, snapshots: MarketSnapshot[], cooldownMs: number): boolean {
  if (snapshots.length === 0) return false;
  const now = Date.now();
  return snapshots.every((s) => {
    const last = getLastTradeAtMs(agentId, s.marketId);
    return last !== undefined && now - last < cooldownMs;
  });
}

export async function runAgentCycle(agent: Agent, snapshots: MarketSnapshot[], cfg: RiskConfig): Promise<void> {
  if (agent.pausedAt) {
    // Paused by its owner — no reasoning, no new trades. Still sweep any
    // winnings so a settled position isn't stranded.
    if (isWalletFunded(agent.id)) await maybeClaimForAgent(agent);
    return;
  }
  if (!(await ensureFunded(agent))) return;
  if (!(await ensureCodeGenerated(agent))) return;

  await maybeClaimForAgent(agent);

  // Produce this cycle's per-market calls. `"code"` agents run their generated
  // decide() in a sandbox (0 LLM calls, so none of the spend gates apply);
  // `"llm"` agents go through the gated LLM path.
  let calls: LlmMarketCall[];
  const codeHolds = new Map<string, { reason: string; reasoning: string }>();

  if (agent.strategyKind === "code") {
    const gen = getGeneratedStrategy(agent.id);
    if (!gen) return; // ensureCodeGenerated already logged/parked it
    const run = await runStrategyCode(gen.code, gen.params, buildCodeMarketViews(snapshots));
    calls = [];
    if (!run.ok) {
      setCodeError(agent.id, `${run.kind}: ${run.message}`);
      log(`${agent.name}: decide() failed — ${run.kind}: ${run.message}`);
      for (const s of snapshots) codeHolds.set(s.marketId, { reason: "code_error", reasoning: `${run.kind}: ${run.message}` });
    } else {
      for (const r of run.results) {
        if (r.decision) calls.push({ marketId: r.marketId, ...r.decision });
        else codeHolds.set(r.marketId, { reason: "code_no_opinion", reasoning: "the strategy returned no opinion this cycle" });
      }
    }
  } else {
    // Spend control, cheapest checks first — each skips the LLM call entirely:
    //   1. nothing the agent watches moved meaningfully since its last look;
    //   2. the agent is inside its trade cooldown on every market (can't act);
    //   3. per-agent budget: min interval between calls + a hard daily cap.
    if (!needsFreshCall(agent.id, snapshots)) return;
    if (allMarketsInCooldown(agent.id, snapshots, cfg.tradeCooldownMs)) return;
    const budget = checkBudget(agent.id);
    if (!budget.allowed) {
      // min_interval is the common, expected case — stay quiet. Only note the
      // hard daily cap, and only once as it flips.
      if (budget.reason === "daily_cap" && !dailyCapNoted.has(agent.id)) {
        dailyCapNoted.add(agent.id);
        log(`${agent.name}: hit the daily LLM call cap — holding until UTC rollover`);
      }
      return;
    }
    dailyCapNoted.delete(agent.id);

    calls = await decideForAgent(agent, snapshots);
    recordCall(agent.id);
    recordCycle(agent.id, snapshots, calls);
  }

  const callByMarket = new Map(calls.map((c) => [c.marketId, c]));
  const cycleId = randomUUID();
  const dailyPnlUsd = getDailyPnlUsd(agent.id);
  let cycleNotionalUsedUsd = 0;

  for (const s of snapshots) {
    const call = callByMarket.get(s.marketId);
    const marketImpliedUp = s.yesMid ?? null;
    const base: Omit<
      DecisionRecord,
      "action" | "skipReason" | "sizeShares" | "limitPrice" | "orderId" | "txHash" | "reasoning"
    > = {
      type: "decision",
      ts: new Date().toISOString(),
      cycleId,
      agentId: agent.id,
      marketId: s.marketId,
      marketSymbol: s.symbol,
      expiresAt: new Date(s.expiresAt * 1000).toISOString(),
      marketImpliedUpProbability: marketImpliedUp,
      llmFairUpProbability: call?.fairUpProbability ?? null,
      confidence: call?.confidence ?? null,
      edge: call && marketImpliedUp !== null ? call.fairUpProbability - marketImpliedUp : null,
      mode: agent.mode,
    };

    if (!call || marketImpliedUp === null) {
      const hold = codeHolds.get(s.marketId);
      appendRecord({
        ...base,
        reasoning: hold?.reasoning ?? call?.reasoning ?? "no usable model call or market data this cycle",
        action: "HOLD",
        skipReason: hold?.reason ?? (!call ? "no_model_call" : "no_market_price"),
        sizeShares: null,
        limitPrice: null,
        orderId: null,
        txHash: null,
      });
      continue;
    }

    const edge = call.fairUpProbability - marketImpliedUp;
    const gate = gateTrade({
      edge,
      confidence: call.confidence,
      cfg,
      lastTradeAtMs: getLastTradeAtMs(agent.id, s.marketId),
      nowMs: Date.now(),
      cycleNotionalUsedUsd,
      dailyPnlUsd,
    });

    if (!gate.allowed) {
      const isHoldNotSkip = gate.skipReason === "below_min_confidence" || gate.skipReason === "below_min_edge";
      appendRecord({
        ...base,
        reasoning: call.reasoning,
        action: isHoldNotSkip ? "HOLD" : "SKIP_RISK_GATED",
        skipReason: gate.skipReason,
        sizeShares: null,
        limitPrice: null,
        orderId: null,
        txHash: null,
      });
      continue;
    }

    const action = edge > 0 ? "BUY_UP" : "BUY_DOWN";
    const sizeUsd = sizeTradeUsd({
      confidence: call.confidence,
      virtualBalanceUsd: agent.virtualBalanceUsd,
      cfg,
      cycleNotionalUsedUsd,
    });

    const fill = await executeLiveTrade(agent, s.marketId, action, sizeUsd);
    if (!fill) {
      appendRecord({
        ...base,
        reasoning: call.reasoning,
        action: "HOLD",
        skipReason: "live_fill_unavailable",
        sizeShares: null,
        limitPrice: null,
        orderId: null,
        txHash: null,
      });
      continue;
    }

    const costUsd = Math.round(fill.sizeShares * fill.limitPrice * 1e4) / 1e4;
    openPosition({
      agentId: agent.id,
      marketId: s.marketId,
      symbol: s.symbol,
      outcome: action === "BUY_UP" ? "YES" : "NO",
      sizeShares: fill.sizeShares,
      entryPrice: fill.limitPrice,
      costUsd,
      mode: "live",
      cycleId,
      fairUpProbability: call.fairUpProbability,
    });
    cycleNotionalUsedUsd += costUsd;
    setLastTradeAtMs(agent.id, s.marketId, Date.now());
    appendRecord({
      ...base,
      reasoning: call.reasoning,
      action,
      skipReason: null,
      sizeShares: fill.sizeShares,
      limitPrice: fill.limitPrice,
      orderId: fill.orderId,
      txHash: fill.txHash,
    });
    commitReasoningAsync({
      agentId: agent.id,
      marketId: s.marketId,
      cycleId,
      reasoning: call.reasoning,
      fairUpProbability: call.fairUpProbability,
      confidence: call.confidence,
      action,
      ts: base.ts,
    });
    log(`${agent.name} ${action} ${fill.sizeShares} ${s.symbol} @ ${fill.limitPrice.toFixed(3)}`);
  }
}
