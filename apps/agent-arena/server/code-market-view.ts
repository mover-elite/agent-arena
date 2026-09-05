// Turns the per-cycle `MarketSnapshot[]` into the plain-object `CodeMarketView[]`
// handed to a generated `decide(market, params, lib)`. Richer than what the LLM
// path sees: the real underlying 1-minute candles, the opening/strike price, and
// the longer implied-probability history — all already in memory.
//
// Used by the engine (agent-engine.ts), the dry-run endpoint, and PATCH { params }
// re-validation.

import { getMarketHistory, getUnderlyingFor } from "./market-state.js";
import type { CodeMarketView, MarketSnapshot } from "./types.js";

/** Underlying price when a window opened — the level "Up" is measured against.
 *  Proxied from the 1-minute candle covering `tradingStartSec` (its open).
 *  null when `tradingStart` predates the kept candle window (longer intervals). */
function strikeFrom(candles: [number, number, number, number, number, number][], tradingStartSec: number): number | null {
  if (candles.length === 0 || !tradingStartSec) return null;
  const tMs = tradingStartSec * 1000;
  if (tMs < candles[0]![0] - 60_000) return null; // window opened before our history — unknown
  let covering = candles[0]!;
  for (const k of candles) {
    if (k[0] <= tMs + 60_000) covering = k;
    else break;
  }
  return covering[1];
}

export function buildCodeMarketView(s: MarketSnapshot): CodeMarketView {
  const asset = s.asset || s.symbol.split("-")[0] || "";
  const u = getUnderlyingFor(asset);
  const candles = u?.candles1m ?? [];
  const spread =
    s.bestYesAsk !== undefined && s.bestYesBid !== undefined ? Math.max(0, s.bestYesAsk - s.bestYesBid) : null;
  return {
    marketId: s.marketId,
    symbol: s.symbol,
    asset,
    question: s.question || `${asset} closes at or above its opening price`,
    intervalSec: s.intervalSec,
    secondsToExpiry: Math.max(0, Math.round(s.secondsToExpiry)),
    tradingStart: s.tradingStart,
    expiresAt: s.expiresAt,
    yesMid: s.yesMid ?? null,
    bestYesBid: s.bestYesBid ?? null,
    bestYesAsk: s.bestYesAsk ?? null,
    spread,
    recentHistory: s.recentHistory.map((p) => p.yesMid),
    history: getMarketHistory(s.marketId).map((p) => p.yesMid),
    strike: strikeFrom(candles, s.tradingStart),
    underlying: u
      ? {
          price: u.price,
          ema: u.ema,
          change24hPct: u.change24hPct,
          high24h: u.high24h,
          low24h: u.low24h,
          candles: candles.map((k) => [k[0], k[1], k[2], k[3], k[4], k[5]] as [number, number, number, number, number, number]),
        }
      : null,
  };
}

export function buildCodeMarketViews(snapshots: MarketSnapshot[]): CodeMarketView[] {
  return snapshots.map(buildCodeMarketView);
}
