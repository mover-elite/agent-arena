// Offline calibration report: for every agent, average the Brier score
// component the settlement-reconciler already computed per settled position,
// plus a hit-rate breakdown by confidence decile. Run with:
//   npm run evaluate -w agent-arena

import { listAgents } from "../server/agents-store.js";
import { readAgentRecords } from "../server/decision-log.js";
import { computeAgentStats } from "../server/stats.js";
import type { DecisionRecord, SettlementRecord } from "../server/types.js";

function decile(confidence: number): string {
  const bucket = Math.min(9, Math.floor(confidence * 10));
  return `${(bucket / 10).toFixed(1)}-${((bucket + 1) / 10).toFixed(1)}`;
}

function main(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No agents registered yet.");
    return;
  }

  for (const agent of agents) {
    const stats = computeAgentStats(agent.id);
    console.log(`\n=== ${agent.name} (${agent.mode}) ===`);
    console.log(`P&L: ${stats.pnlUsd.toFixed(2)}  settled: ${stats.settledCount}  avg Brier: ${stats.avgBrier?.toFixed(4) ?? "—"}`);

    const records = readAgentRecords(agent.id);
    const decisions = new Map<string, DecisionRecord>();
    for (const r of records) {
      if (r.type === "decision" && (r.action === "BUY_UP" || r.action === "BUY_DOWN")) decisions.set(r.cycleId, r);
    }
    const settlements = records.filter((r): r is SettlementRecord => r.type === "settlement");

    if (settlements.length === 0) {
      console.log("  no settled positions yet.");
      continue;
    }

    const buckets = new Map<string, { n: number; hits: number; brierSum: number }>();
    for (const s of settlements) {
      const decision = s.referencedDecisionCycleIds.map((id) => decisions.get(id)).find(Boolean);
      if (!decision || decision.confidence === null) continue;
      const bucket = decile(decision.confidence);
      const b = buckets.get(bucket) ?? { n: 0, hits: 0, brierSum: 0 };
      b.n += 1;
      if (s.llmBrierComponent !== null) b.brierSum += s.llmBrierComponent;
      const won = s.realizedPnlUsd > 0;
      if (won) b.hits += 1;
      buckets.set(bucket, b);
    }

    console.log("  confidence  n   hitRate  avgBrier");
    for (const [bucket, b] of [...buckets.entries()].sort()) {
      console.log(`  ${bucket.padEnd(10)} ${String(b.n).padEnd(3)} ${((b.hits / b.n) * 100).toFixed(0).padStart(5)}%   ${(b.brierSum / b.n).toFixed(4)}`);
    }
  }
}

main();
