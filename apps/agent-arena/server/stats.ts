// Leaderboard-facing stats: realized P&L comes from SQLite (agents-store is
// the operational source of truth), calibration (Brier score) comes from the
// JSONL settlement records, since that's where the LLM's original
// probability call and the real outcome both get written down together.

import { getAgentPnlUsd, getBestPnlUsd } from "./agents-store.js";
import { readAgentRecords } from "./decision-log.js";

export interface AgentStats {
  pnlUsd: number;
  bestPnlUsd: number;
  isAtPersonalBest: boolean;
  settledCount: number;
  avgBrier: number | null;
  lastActivityTs: string | null;
}

export function computeAgentStats(agentId: string): AgentStats {
  const records = readAgentRecords(agentId);
  const settlements = records.filter((r) => r.type === "settlement");
  const briers = settlements.map((r) => r.llmBrierComponent).filter((b): b is number => b !== null);
  const lastActivityTs = records.length > 0 ? records[records.length - 1]!.ts : null;
  const pnlUsd = getAgentPnlUsd(agentId);
  const bestPnlUsd = getBestPnlUsd(agentId);

  return {
    pnlUsd,
    bestPnlUsd,
    isAtPersonalBest: settlements.length > 0 && pnlUsd >= bestPnlUsd && pnlUsd > 0,
    settledCount: settlements.length,
    avgBrier: briers.length > 0 ? briers.reduce((a, b) => a + b, 0) / briers.length : null,
    lastActivityTs,
  };
}
