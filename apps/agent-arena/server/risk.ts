// Sizing + gating. Pure functions — no I/O, no chain/LLM calls — so they're
// trivial to unit test and identical for paper and live execution.

import type { RiskConfig } from "./types.js";

export function loadRiskConfig(): RiskConfig {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    maxPositionPerMarketUsd: num("MAX_POSITION_PER_MARKET_USD", 50),
    maxCycleNotionalUsd: num("MAX_CYCLE_NOTIONAL_USD", 150),
    dailyLossCapUsd: num("DAILY_LOSS_CAP_USD", 200),
    minConfidence: num("MIN_CONFIDENCE_THRESHOLD", 0.6),
    minEdge: num("MIN_EDGE_THRESHOLD", 0.05),
    tradeCooldownMs: num("TRADE_COOLDOWN_MS", 60_000),
  };
}

export interface GateInput {
  edge: number; // signed: llmFairUp - marketImpliedUp
  confidence: number;
  cfg: RiskConfig;
  lastTradeAtMs: number | undefined;
  nowMs: number;
  cycleNotionalUsedUsd: number;
  dailyPnlUsd: number;
}

export interface GateResult {
  allowed: boolean;
  skipReason: string | null;
}

export function gateTrade(input: GateInput): GateResult {
  const { edge, confidence, cfg, lastTradeAtMs, nowMs, cycleNotionalUsedUsd, dailyPnlUsd } = input;
  if (dailyPnlUsd <= -Math.abs(cfg.dailyLossCapUsd)) return { allowed: false, skipReason: "daily_loss_cap" };
  if (confidence < cfg.minConfidence) return { allowed: false, skipReason: "below_min_confidence" };
  if (Math.abs(edge) < cfg.minEdge) return { allowed: false, skipReason: "below_min_edge" };
  if (lastTradeAtMs !== undefined && nowMs - lastTradeAtMs < cfg.tradeCooldownMs) return { allowed: false, skipReason: "cooldown" };
  if (cycleNotionalUsedUsd >= cfg.maxCycleNotionalUsd) return { allowed: false, skipReason: "cycle_notional_cap" };
  return { allowed: true, skipReason: null };
}

/** Linear-in-confidence sizing, capped by per-market and remaining-cycle budgets. */
export function sizeTradeUsd(params: {
  confidence: number;
  virtualBalanceUsd: number;
  cfg: RiskConfig;
  cycleNotionalUsedUsd: number;
}): number {
  const { confidence, virtualBalanceUsd, cfg, cycleNotionalUsedUsd } = params;
  const raw = confidence * cfg.maxPositionPerMarketUsd;
  const cycleRemaining = Math.max(0, cfg.maxCycleNotionalUsd - cycleNotionalUsedUsd);
  const balanceCap = Math.max(0, virtualBalanceUsd);
  return Math.max(0, Math.min(raw, cfg.maxPositionPerMarketUsd, cycleRemaining, balanceCap));
}
