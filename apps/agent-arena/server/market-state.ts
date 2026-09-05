// In-memory snapshot of what the market loop is seeing right now, so the
// dashboard API can serve live market data without re-hitting the venue.
// Written once per cycle by runMarketLoop (index.ts); read by api/dashboard.ts.
// Losing it on restart is harmless — the next cycle repopulates it.

import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { MarketSnapshot } from "./types.js";

export interface MarketHistoryPoint {
  ts: number;
  yesMid: number;
}

/** [tsMs, open, high, low, close, volume] — the SDK's UnifiedOHLCV shape. */
export type Candle = [number, number, number, number, number, number];

export interface UnderlyingState {
  asset: string;
  price: number;
  ema: number;
  ts: number;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  candles1m: Candle[];
}

const underlying = new Map<string, UnderlyingState>();

const LONG_HISTORY = 360; // ~ a few hours at a 30s cycle — enough for a session chart
const longHistory = new Map<string, MarketHistoryPoint[]>();

let latest: MarketSnapshot[] = [];
let lastCycleStartedAt = 0;
let lastCycleFinishedAt = 0;
let cycleIntervalMs = Number(process.env.CYCLE_INTERVAL_MS ?? 30_000);
let cycleCount = 0;

export function markCycleStart(): void {
  lastCycleStartedAt = Date.now();
}

export function publishSnapshots(snapshots: MarketSnapshot[]): void {
  latest = snapshots;
  lastCycleFinishedAt = Date.now();
  cycleCount += 1;
  const liveIds = new Set<string>(snapshots.map((s) => s.marketId));
  for (const s of snapshots) {
    if (s.yesMid === undefined) continue;
    const buf = longHistory.get(s.marketId) ?? [];
    const last = buf[buf.length - 1];
    // De-dupe: only append when the mid actually moved or ~a cycle has passed.
    if (!last || last.yesMid !== s.yesMid || Date.now() - last.ts > cycleIntervalMs) {
      buf.push({ ts: Date.now(), yesMid: s.yesMid });
      while (buf.length > LONG_HISTORY) buf.shift();
      longHistory.set(s.marketId, buf);
    }
  }
  for (const id of [...longHistory.keys()]) if (!liveIds.has(id)) longHistory.delete(id);
}

export function getLatestSnapshots(): MarketSnapshot[] {
  return latest;
}

export function getMarketHistory(marketId: string): MarketHistoryPoint[] {
  return longHistory.get(marketId) ?? [];
}

// ── Underlying BTC/ETH spot, from the SDK's on-chain EMA price feed ───────
// Real data — a live tick + 1-minute candles — so the dashboard has a proper
// price chart from the first render, not a slowly-filling line.

const CANDLE_LIMIT = 150;
const H1_TTL_MS = 45_000; // the 24h window moves slowly — don't re-fetch 1h candles every tick

// Per-asset cache of the slow 24h stats so change% can still track the live
// price between 1h-candle fetches.
const h1cache = new Map<string, { at: number; ref24h: number; high24h: number; low24h: number }>();

async function refreshOne(exchange: SomniaMarkets, asset: string): Promise<void> {
  const now = Date.now();
  const prev = underlying.get(asset);
  const cached1h = h1cache.get(asset);
  const need1h = !cached1h || now - cached1h.at > H1_TTL_MS;

  const [tick, c1m, c1h] = await Promise.all([
    exchange.fetchPrice(asset).catch(() => null),
    exchange.fetchPriceOHLCV(asset, "1m", undefined, CANDLE_LIMIT).catch(() => [] as Candle[]),
    need1h ? exchange.fetchPriceOHLCV(asset, "1h", undefined, 26).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
  ]);
  if (!tick && (c1m as Candle[]).length === 0 && !prev) return;

  let candles1m: Candle[] = (c1m as Candle[]).length ? (c1m as Candle[]).slice(-CANDLE_LIMIT) : (prev?.candles1m ?? []).slice();
  const livePrice = tick?.price ?? candles1m[candles1m.length - 1]?.[4] ?? prev?.price ?? 0;

  // Fold the live tick into the forming candle so the chart's right edge moves
  // every few seconds instead of once a minute.
  if (tick && candles1m.length) {
    const last = candles1m[candles1m.length - 1]!;
    if (tick.timestamp - last[0] < 90_000) {
      const merged: Candle = [last[0], last[1], Math.max(last[2], tick.price), Math.min(last[3], tick.price), tick.price, last[5]];
      candles1m = [...candles1m.slice(0, -1), merged];
    } else {
      const forming: Candle = [tick.timestamp, tick.price, tick.price, tick.price, tick.price, 0];
      candles1m = [...candles1m, forming].slice(-CANDLE_LIMIT);
    }
  }

  // 24h stats: refresh from 1h candles when due, otherwise reuse the cached
  // reference and recompute the % against the fresh price.
  const window = (c1h as Candle[]).slice(-25);
  if (window.length >= 2 && window[0]) {
    h1cache.set(asset, {
      at: now,
      ref24h: window[0][1],
      high24h: Math.max(...window.map((k) => k[2])),
      low24h: Math.min(...window.map((k) => k[3])),
    });
  }
  const h1 = h1cache.get(asset);
  const change24hPct = h1 && h1.ref24h ? ((livePrice - h1.ref24h) / h1.ref24h) * 100 : (prev?.change24hPct ?? null);
  const high24h = h1 ? Math.max(h1.high24h, livePrice) : (prev?.high24h ?? null);
  const low24h = h1 ? Math.min(h1.low24h, livePrice) : (prev?.low24h ?? null);

  underlying.set(asset, {
    asset,
    price: livePrice,
    ema: tick?.ema ?? livePrice,
    ts: tick?.timestamp ?? now,
    change24hPct,
    high24h,
    low24h,
    candles1m,
  });
}

/** Called every few seconds by the price-feed loop (index.ts); never throws. */
export async function refreshUnderlying(exchange: SomniaMarkets, assets: string[]): Promise<void> {
  await Promise.all(assets.map((a) => refreshOne(exchange, a).catch(() => undefined)));
}

export function getUnderlying(): UnderlyingState[] {
  return [...underlying.values()];
}

export function getUnderlyingFor(asset: string): UnderlyingState | undefined {
  return underlying.get((asset || "").toUpperCase());
}

export function getCycleTiming(): {
  intervalMs: number;
  lastStartedAt: number;
  lastFinishedAt: number;
  nextEta: number;
  cycleCount: number;
} {
  return {
    intervalMs: cycleIntervalMs,
    lastStartedAt: lastCycleStartedAt,
    lastFinishedAt: lastCycleFinishedAt,
    nextEta: lastCycleStartedAt ? lastCycleStartedAt + cycleIntervalMs : 0,
    cycleCount,
  };
}
