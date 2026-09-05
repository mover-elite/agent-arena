// Differentiator §6c: featured head-to-head matchup between two agents on
// the same market. Pure read/compose over data the engine already produces
// (each agent's own decision + settlement records) — no new decision logic.

import { getAgent } from "./agents-store.js";
import { readAgentRecords } from "./decision-log.js";
import type { Agent, DecisionRecord, SettlementRecord } from "./types.js";

export interface DuelResult {
  found: boolean;
  marketId?: string;
  marketSymbol?: string;
  agentA?: Agent;
  agentB?: Agent;
  decisionA?: DecisionRecord;
  decisionB?: DecisionRecord;
  outcome?: "Up" | "Down" | "Void";
  settled: boolean;
  closerCall?: "a" | "b" | "tie";
  pnlWinner?: "a" | "b" | "tie";
}

function latestDecisionsByMarket(agentId: string): Map<string, DecisionRecord> {
  const out = new Map<string, DecisionRecord>();
  for (const r of readAgentRecords(agentId)) {
    if (r.type !== "decision") continue;
    const existing = out.get(r.marketId);
    if (!existing || r.ts > existing.ts) out.set(r.marketId, r);
  }
  return out;
}

function settlementFor(agentId: string, marketId: string): SettlementRecord | undefined {
  return readAgentRecords(agentId).find((r): r is SettlementRecord => r.type === "settlement" && r.marketId === marketId);
}

export function computeDuel(agentIdA: string, agentIdB: string, marketId?: string): DuelResult {
  const agentA = getAgent(agentIdA);
  const agentB = getAgent(agentIdB);
  if (!agentA || !agentB) return { found: false, settled: false };

  const byMarketA = latestDecisionsByMarket(agentIdA);
  const byMarketB = latestDecisionsByMarket(agentIdB);

  let chosenMarketId = marketId;
  if (!chosenMarketId) {
    let bestTs = "";
    for (const [mid, decisionA] of byMarketA) {
      const decisionB = byMarketB.get(mid);
      if (!decisionB) continue;
      const ts = decisionA.ts > decisionB.ts ? decisionA.ts : decisionB.ts;
      if (ts > bestTs) {
        bestTs = ts;
        chosenMarketId = mid;
      }
    }
  }
  if (!chosenMarketId) return { found: false, settled: false, agentA, agentB };

  const decisionA = byMarketA.get(chosenMarketId);
  const decisionB = byMarketB.get(chosenMarketId);
  if (!decisionA || !decisionB) return { found: false, settled: false, agentA, agentB };

  const settlementA = settlementFor(agentIdA, chosenMarketId);
  const settlementB = settlementFor(agentIdB, chosenMarketId);
  const outcome = settlementA?.outcome ?? settlementB?.outcome;

  const result: DuelResult = {
    found: true,
    marketId: chosenMarketId,
    marketSymbol: decisionA.marketSymbol,
    agentA,
    agentB,
    decisionA,
    decisionB,
    outcome,
    settled: outcome !== undefined,
  };

  if (outcome && outcome !== "Void") {
    const actualUp01 = outcome === "Up" ? 1 : 0;
    const errA = decisionA.llmFairUpProbability !== null ? Math.abs(decisionA.llmFairUpProbability - actualUp01) : null;
    const errB = decisionB.llmFairUpProbability !== null ? Math.abs(decisionB.llmFairUpProbability - actualUp01) : null;
    if (errA !== null && errB !== null) {
      result.closerCall = errA < errB ? "a" : errB < errA ? "b" : "tie";
    }
  }

  if (settlementA || settlementB) {
    const pnlA = settlementA?.realizedPnlUsd ?? 0;
    const pnlB = settlementB?.realizedPnlUsd ?? 0;
    if (settlementA && settlementB) result.pnlWinner = pnlA > pnlB ? "a" : pnlB > pnlA ? "b" : "tie";
    else if (settlementA) result.pnlWinner = pnlA > 0 ? "a" : pnlA < 0 ? "b" : "tie";
    else if (settlementB) result.pnlWinner = pnlB > 0 ? "b" : pnlB < 0 ? "a" : "tie";
  }

  return result;
}
