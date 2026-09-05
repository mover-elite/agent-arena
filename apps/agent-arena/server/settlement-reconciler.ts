// Periodic pass: for every open position, check
// whether its market has resolved on-chain yet. If so, compute the real
// payout (winner pays 1 - settlement fee, loser 0, void 0.5 - the same rule
// live positions redeem under), close the position, adjust the agent's
// balance, and append a `settlement` log record with a Brier-score component
// scoring the LLM's original probability call against the real outcome.

import {
  outcomeIdxOf,
  toRawUnits,
  estimatePayout,
  settlementFeeBps,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";
import type { UnifiedMarket } from "@somnia-chain/markets-sdk";
import { bumpBestPnlIfHigher, closePosition, getAgentPnlUsd, getOpenPositions, type Position } from "./agents-store.js";
import { appendRecord } from "./decision-log.js";
import type { SettlementRecord } from "./types.js";

const log = (s: string) => console.log(`${new Date().toISOString()} [reconciler] ${s}`);

/** Positions grouped by marketId so we only look each market's on-chain state up once. */
function groupByMarket(positions: Position[]): Map<string, Position[]> {
  const out = new Map<string, Position[]>();
  for (const p of positions) {
    const list = out.get(p.marketId) ?? [];
    list.push(p);
    out.set(p.marketId, list);
  }
  return out;
}

export async function reconcileSettlements(ctx: EcContext): Promise<void> {
  const open = getOpenPositions();
  if (open.length === 0) return;

  for (const [marketId, positions] of groupByMarket(open)) {
    const onchain = await ctx.exchange.client.getMarketOnchain(marketId as `0x${string}`).catch(() => null);
    if (!onchain || (!onchain.isResolved && !onchain.isVoided)) continue;

    const pseudoMarket = {
      symbol: positions[0]?.symbol ?? marketId,
      info: { marketType: "BINARY", marketId },
    } as unknown as UnifiedMarket;
    const feeBps = await settlementFeeBps(ctx, pseudoMarket, onchain).catch(() => 0n);

    const outcomeLabel: "Up" | "Down" | "Void" = onchain.isVoided
      ? "Void"
      : onchain.winningOutcome === 0
        ? "Up"
        : "Down";
    const actualUp01 = onchain.isVoided ? 0.5 : onchain.winningOutcome === 0 ? 1 : 0;

    for (const pos of positions) {
      const rawAmount = toRawUnits(pos.sizeShares, ctx.config.decimals);
      const payoutRaw = estimatePayout({ onchain, outcome: outcomeIdxOf(pos.outcome), amount: rawAmount, feeBps });
      const payoutUsd = Number(payoutRaw) / 10 ** ctx.config.decimals;
      const realizedPnlUsd = Math.round((payoutUsd - pos.costUsd) * 1e4) / 1e4;

      closePosition(pos.id, realizedPnlUsd);
      const isNewBest = bumpBestPnlIfHigher(pos.agentId, getAgentPnlUsd(pos.agentId));
      if (isNewBest) log(`${pos.agentId.slice(0, 8)} hit a new personal-best P&L`);

      const brier =
        pos.fairUpProbability !== null ? Math.round((pos.fairUpProbability - actualUp01) ** 2 * 1e6) / 1e6 : null;

      const record: SettlementRecord = {
        type: "settlement",
        ts: new Date().toISOString(),
        agentId: pos.agentId,
        marketId,
        outcome: outcomeLabel,
        realizedPnlUsd,
        referencedDecisionCycleIds: [pos.cycleId],
        llmBrierComponent: brier,
      };
      appendRecord(record);
      log(`${pos.agentId.slice(0, 8)} ${pos.symbol} ${pos.outcome} -> ${outcomeLabel}: pnl ${realizedPnlUsd.toFixed(4)}`);
    }
  }
}
