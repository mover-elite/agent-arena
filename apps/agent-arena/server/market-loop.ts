// Builds ONE shared per-cycle snapshot of the watchlisted Event Contract
// markets, reused by every agent's LLM call. ec-core exposes no candle/OHLCV
// feed for binary markets (only top-of-book via `snapshot`/`fetchOrderBook`),
// so "recent price action" is our own rolling buffer, kept here across cycles.

import {
  activeMarkets,
  marketOnchain,
  isTradable,
  minLeftSec,
  outcomeSymbols,
  snapshot as fetchTopOfBook,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";
import type { MarketPricePoint, MarketSnapshot } from "./types.js";

const HISTORY_LIMIT = 20;
const history = new Map<string, MarketPricePoint[]>();

function pushHistory(marketId: string, point: MarketPricePoint): MarketPricePoint[] {
  const buf = history.get(marketId) ?? [];
  buf.push(point);
  while (buf.length > HISTORY_LIMIT) buf.shift();
  history.set(marketId, buf);
  return buf;
}

/** Watchlist is asset symbols (e.g. ["BTC", "ETH"]); empty = whatever the venue runs. */
export async function buildMarketSnapshots(ctx: EcContext, watchlist: string[]): Promise<MarketSnapshot[]> {
  const markets = await activeMarkets(ctx, { max: 25 });
  const wanted =
    watchlist.length === 0
      ? markets
      : markets.filter((m) => watchlist.some((a) => m.symbol.toUpperCase().includes(a.toUpperCase())));

  const snapshots: MarketSnapshot[] = [];
  for (const market of wanted) {
    if (market.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ctx, market);
    if (!onchain || !isTradable(onchain)) continue;

    // `isTradable` only checks the status enum. Near expiry the venue still
    // reports Trading but rejects new orders (an IOC there reverts "for an
    // unknown reason"), so also demand the kit's per-series headroom — this is
    // what its own strategies do. Agents never see a market they couldn't act on.
    const intervalSec = Number(market.info.intervalSec ?? 0);
    const secondsToExpiry = Number(onchain.expiry) - Date.now() / 1000;
    if (secondsToExpiry < minLeftSec(intervalSec || undefined)) continue;

    const { yes } = outcomeSymbols(market);
    const ob = await fetchTopOfBook(ctx, yes, 5);
    const marketId = market.info.marketId as `0x${string}`;
    const now = Date.now();

    if (ob.yesMid !== undefined) pushHistory(marketId, { ts: now, yesMid: ob.yesMid });

    const expiresAt = Number(onchain.expiry);
    const info = market.info as { tradingStart?: unknown; question?: unknown };
    const tradingStart = Number(info.tradingStart ?? expiresAt - intervalSec) || expiresAt - intervalSec;

    snapshots.push({
      marketId,
      symbol: market.symbol,
      asset: String(market.info.asset ?? ""),
      intervalSec,
      tradingStart,
      question: typeof info.question === "string" ? info.question : "",
      expiresAt,
      secondsToExpiry: expiresAt - now / 1000,
      bestYesBid: ob.bestYesBid,
      bestYesAsk: ob.bestYesAsk,
      yesMid: ob.yesMid,
      recentHistory: [...(history.get(marketId) ?? [])],
    });
  }

  // Drop history for markets no longer in scope (expired / rolled over) so the
  // buffer doesn't grow unbounded across a long-running process.
  const liveIds = new Set<string>(snapshots.map((s) => s.marketId));
  for (const id of [...history.keys()]) if (!liveIds.has(id)) history.delete(id);

  return snapshots;
}
