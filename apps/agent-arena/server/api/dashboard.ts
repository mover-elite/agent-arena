// Read-only, CORS-open dashboard API — everything the homepage needs to feel
// alive: live market snapshots + history, a fleet-wide activity stream, and
// aggregate stats. All derived from state the engine already produces
// (market-state.ts + the JSONL decision logs + SQLite), nothing new to trust.

import { Router } from "express";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import { getAgent, getAgentPnlUsd, isWalletFunded, listAgents, listAllPositions } from "../agents-store.js";
import { listLoggedAgentIds, readAgentRecords } from "../decision-log.js";
import { computeAgentStats } from "../stats.js";
import { currentProvider } from "../llm-decide.js";
import { loadRiskConfig } from "../risk.js";
import { getCycleTiming, getLatestSnapshots, getMarketHistory, getUnderlying, getUnderlyingFor } from "../market-state.js";
import { budgetConfig, fleetCallsToday } from "../llm-budget.js";
import type { DecisionRecord, LogRecord, SettlementRecord } from "../types.js";

export const dashboardRouter = Router();

dashboardRouter.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

/** The underlying's price when a window opened — the reference these
 *  "close at/above opening price" contracts settle against. Proxied from the
 *  1-minute candle covering `tradingStartSec` (open of that candle). */
function strikeFor(asset: string, tradingStartSec: number): number | null {
  const u = getUnderlyingFor(asset);
  if (!u || !u.candles1m.length || !tradingStartSec) return null;
  const tMs = tradingStartSec * 1000;
  let best: number[] | null = null;
  for (const k of u.candles1m) {
    if (k[0] <= tMs + 60_000) best = k;
    else break;
  }
  best = best ?? u.candles1m[0]!;
  return best[1] ?? null; // open of the window's first candle
}

const nameOf = (() => {
  let cache: Map<string, string> | null = null;
  let cachedAt = 0;
  return (agentId: string): string => {
    if (!cache || Date.now() - cachedAt > 5_000) {
      cache = new Map(listAgents().map((a) => [a.id, a.name]));
      cachedAt = Date.now();
    }
    return cache.get(agentId) ?? agentId.slice(0, 8);
  };
})();

/** Recent decision/settlement/receipt records for one agent, newest first. */
function recentFor(agentId: string, perAgent: number): LogRecord[] {
  return readAgentRecords(agentId).slice(-perAgent).reverse();
}

// ── Live markets ─────────────────────────────────────────────────────────
dashboardRouter.get("/markets", (_req, res) => {
  const snaps = getLatestSnapshots();
  const nowSec = Date.now() / 1000;
  const markets = snaps.map((s) => {
    const hist = getMarketHistory(s.marketId);
    const spread =
      s.bestYesAsk !== undefined && s.bestYesBid !== undefined ? Math.max(0, s.bestYesAsk - s.bestYesBid) : null;
    const u = getUnderlyingFor(s.asset || s.symbol.split("-")[0]!);
    return {
      marketId: s.marketId,
      symbol: s.symbol,
      asset: s.asset,
      question: s.question || null,
      intervalSec: s.intervalSec,
      tradingStart: s.tradingStart,
      expiresAt: s.expiresAt,
      secondsToExpiry: Math.max(0, Math.round(s.expiresAt - nowSec)),
      strike: strikeFor(s.asset || s.symbol.split("-")[0]!, s.tradingStart),
      impliedUp: s.yesMid ?? null,
      bestYesBid: s.bestYesBid ?? null,
      bestYesAsk: s.bestYesAsk ?? null,
      spread,
      underlyingPrice: u?.price ?? null,
      underlyingChangePct: u?.change24hPct ?? null,
      history: hist.map((p) => ({ ts: p.ts, up: p.yesMid })),
    };
  });
  markets.sort((a, b) => a.secondsToExpiry - b.secondsToExpiry);
  res.json({ markets, underlying: getUnderlying(), cycle: getCycleTiming() });
});

// ── Underlying spot (BTC/ETH) — real price feed, live tick + 1m candles ──
dashboardRouter.get("/underlying", (_req, res) => {
  res.json({ underlying: getUnderlying() });
});

// ── One market, with the trades agents placed on it plotted against price ──
dashboardRouter.get("/markets/:id/detail", (req, res) => {
  const id = req.params.id ?? "";
  const snap = getLatestSnapshots().find((s) => s.marketId === id);
  const history = getMarketHistory(id).map((p) => ({ ts: p.ts, up: p.yesMid }));
  const trades: {
    ts: string;
    agentId: string;
    agentName: string;
    action: string;
    price: number | null;
    edge: number | null;
    reasoning: string;
    cycleId: string;
    settled: boolean;
    outcome: "Up" | "Down" | "Void" | null;
    pnlUsd: number | null;
    brier: number | null;
  }[] = [];
  // Settlements for this market, keyed by "<agentId>|<decisionCycleId>" so each
  // entry trade can be matched to its realised result.
  const settleByCycle = new Map<string, SettlementRecord>();
  let marketOutcome: "Up" | "Down" | "Void" | null = null;
  // Fallbacks from the audit log so a market that's already rolled out of the
  // live snapshot set (settled / expired) still resolves its asset + timing —
  // otherwise the deep-linked featured chart has no underlying feed to draw.
  let logSymbol: string | null = null;
  let logExpiresAtIso: string | null = null;
  for (const agentId of listLoggedAgentIds()) {
    for (const r of readAgentRecords(agentId)) {
      if (r.type !== "settlement" || r.marketId !== id) continue;
      const s = r as SettlementRecord;
      marketOutcome = s.outcome;
      for (const cid of s.referencedDecisionCycleIds) settleByCycle.set(`${agentId}|${cid}`, s);
    }
  }
  for (const agentId of listLoggedAgentIds()) {
    for (const r of readAgentRecords(agentId)) {
      if (r.type !== "decision" || r.marketId !== id) continue;
      if (!logSymbol && r.marketSymbol) logSymbol = r.marketSymbol;
      if (!logExpiresAtIso && r.expiresAt) logExpiresAtIso = r.expiresAt;
      if (r.action !== "BUY_UP" && r.action !== "BUY_DOWN") continue;
      const s = settleByCycle.get(`${agentId}|${r.cycleId}`);
      trades.push({
        ts: r.ts,
        agentId,
        agentName: nameOf(agentId),
        action: r.action,
        price: r.limitPrice ?? r.marketImpliedUpProbability,
        edge: r.edge,
        reasoning: r.reasoning,
        cycleId: r.cycleId,
        settled: Boolean(s),
        outcome: s ? s.outcome : null,
        pnlUsd: s ? s.realizedPnlUsd : null,
        brier: s ? s.llmBrierComponent : null,
      });
    }
  }
  trades.sort((a, b) => a.ts.localeCompare(b.ts));
  const symbol = snap?.symbol ?? logSymbol ?? null;
  const asset = snap?.asset || symbol?.split("-")[0] || "";
  const u = getUnderlyingFor(asset);
  const expiresAtSec = snap?.expiresAt ?? (logExpiresAtIso ? Date.parse(logExpiresAtIso) / 1000 : null);
  res.json({
    marketId: id,
    found: Boolean(snap),
    symbol,
    asset,
    question: snap?.question || (symbol ? `${asset} closes at or above its opening price` : null),
    impliedUp: snap?.yesMid ?? null,
    tradingStart: snap?.tradingStart ?? null,
    expiresAt: expiresAtSec,
    secondsToExpiry: expiresAtSec != null ? Math.max(0, Math.round(expiresAtSec - Date.now() / 1000)) : null,
    strike: snap ? strikeFor(asset, snap.tradingStart) : null,
    outcome: marketOutcome,
    history,
    trades,
    underlying: u
      ? { price: u.price, ema: u.ema, change24hPct: u.change24hPct, high24h: u.high24h, low24h: u.low24h, candles: u.candles1m }
      : null,
  });
});

// ── Fleet-wide activity stream ───────────────────────────────────────────
dashboardRouter.get("/activity", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)));
  const all: (LogRecord & { agentName: string })[] = [];
  for (const agentId of listLoggedAgentIds()) {
    for (const r of recentFor(agentId, 40)) {
      all.push({ ...r, agentName: nameOf(agentId) });
    }
  }
  all.sort((a, b) => b.ts.localeCompare(a.ts));
  res.json({ activity: all.slice(0, limit) });
});

// ── Positions: pending (open) + settled — the trade ledger ───────────────
dashboardRouter.get("/positions", (_req, res) => {
  // market resolution per position, matched on the opening decision's cycleId
  const settleByKey = new Map<string, SettlementRecord>();
  for (const agentId of listLoggedAgentIds()) {
    for (const r of readAgentRecords(agentId)) {
      if (r.type !== "settlement") continue;
      const s = r as SettlementRecord;
      for (const cid of s.referencedDecisionCycleIds) settleByKey.set(`${agentId}|${cid}`, s);
    }
  }
  const rows = listAllPositions(500).map((p) => {
    const side = p.outcome === "YES" ? "Up" : "Down";
    const s = settleByKey.get(`${p.agentId}|${p.cycleId}`);
    const returnPct = p.status === "settled" && p.realizedPnlUsd != null && p.costUsd > 0 ? p.realizedPnlUsd / p.costUsd : null;
    return {
      id: p.id,
      agentId: p.agentId,
      agentName: nameOf(p.agentId),
      marketId: p.marketId,
      symbol: p.symbol,
      asset: p.symbol.split("-")[0] || "",
      side,
      sizeShares: p.sizeShares,
      entryPrice: p.entryPrice,
      costUsd: p.costUsd,
      fairUpProbability: p.fairUpProbability,
      status: p.status,
      outcome: s ? s.outcome : null,
      realizedPnlUsd: p.status === "settled" ? p.realizedPnlUsd : null,
      returnPct,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    };
  });
  const open = rows.filter((r) => r.status === "open");
  const settled = rows.filter((r) => r.status === "settled");
  res.json({
    positions: rows,
    summary: {
      openCount: open.length,
      openCostUsd: open.reduce((s, r) => s + r.costUsd, 0),
      settledCount: settled.length,
      settledPnlUsd: settled.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0),
      wins: settled.filter((r) => (r.realizedPnlUsd ?? 0) > 0).length,
    },
  });
});

// ── Fleet aggregates + engine status ─────────────────────────────────────
dashboardRouter.get("/overview", (_req, res) => {
  const agents = listAgents();
  const ecCfg = loadConfig();
  const cycle = getCycleTiming();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  let tradesTotal = 0;
  let trades24h = 0;
  let settledTotal = 0;
  let fleetPnl = 0;
  const brierParts: number[] = [];
  let lastActivityTs: string | null = null;

  for (const agentId of listLoggedAgentIds()) {
    for (const r of readAgentRecords(agentId)) {
      if (!lastActivityTs || r.ts > lastActivityTs) lastActivityTs = r.ts;
      if (r.type === "decision" && (r.action === "BUY_UP" || r.action === "BUY_DOWN")) {
        tradesTotal += 1;
        if (Date.parse(r.ts) >= dayAgo) trades24h += 1;
      } else if (r.type === "settlement") {
        settledTotal += 1;
        if ((r as SettlementRecord).llmBrierComponent !== null) brierParts.push((r as SettlementRecord).llmBrierComponent!);
      }
    }
  }
  for (const a of agents) fleetPnl += getAgentPnlUsd(a.id);

  const funded = agents.filter((a) => isWalletFunded(a.id)).length;
  const markets = getLatestSnapshots();

  res.json({
    engine: {
      network: ecCfg.network,
      dryRun: ecCfg.dryRun,
      llmProvider: currentProvider(),
      risk: loadRiskConfig(),
      cycle,
      marketsLive: markets.length,
      watchlist: (process.env.WATCHLIST ?? "BTC,ETH").split(",").map((s) => s.trim()).filter(Boolean),
      llmBudget: budgetConfig(),
    },
    fleet: {
      agents: agents.length,
      funded,
      provisioning: agents.length - funded,
      tradesTotal,
      trades24h,
      settledTotal,
      fleetPnlUsd: Math.round(fleetPnl * 100) / 100,
      avgBrier: brierParts.length ? Math.round((brierParts.reduce((x, y) => x + y, 0) / brierParts.length) * 1e4) / 1e4 : null,
      llmCallsToday: fleetCallsToday(),
      lastActivityTs,
    },
  });
});

// tiny helper endpoint kept for symmetry with computeAgentStats callers
dashboardRouter.get("/agents/:id/stats", (req, res) => {
  const a = getAgent(req.params.id ?? "");
  if (!a) return void res.status(404).json({ error: "not found" });
  res.json({ stats: computeAgentStats(a.id) });
});

export type { DecisionRecord };
