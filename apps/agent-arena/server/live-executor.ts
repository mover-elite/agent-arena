// Live execution against an agent's OWN dedicated wallet (see
// agent-wallet.ts) — no cross-agent netting needed any more. Each agent
// trades and claims independently; there is no shared-wallet self-match risk
// because there is no shared wallet.

import {
  activeMarkets,
  marketOnchain,
  isTradable,
  outcomeSymbols,
  snapshot as fetchTopOfBook,
  quantize,
  placeLimit,
  claimSettled,
} from "@dreamdex-bot-kit/ec-core";
import { getAgentExchange } from "./agent-wallet.js";
import { getAgentWalletPrivateKey } from "./agents-store.js";
import type { Agent } from "./types.js";

const log = (s: string) => console.log(`${new Date().toISOString()} [live] ${s}`);

export interface LiveFillResult {
  sizeShares: number;
  limitPrice: number;
  orderId: string | null;
  txHash: string | null;
}

export async function executeLiveTrade(
  agent: Agent,
  marketId: string,
  action: "BUY_UP" | "BUY_DOWN",
  sizeUsd: number,
): Promise<LiveFillResult | null> {
  const privateKey = getAgentWalletPrivateKey(agent.id);
  if (!privateKey) return null;
  const ctx = getAgentExchange(agent.id, privateKey);

  const markets = await activeMarkets(ctx, { max: 25 });
  const market = markets.find((m) => m.info.marketType === "BINARY" && m.info.marketId === marketId);
  if (!market) return null;
  const onchain = await marketOnchain(ctx, market);
  if (!onchain || !isTradable(onchain)) return null;

  const { yes } = outcomeSymbols(market);
  const ob = await fetchTopOfBook(ctx, yes, 5);
  const price = action === "BUY_UP" ? ob.bestYesAsk : ob.bestYesBid !== undefined ? 1 - ob.bestYesBid : undefined;
  if (price === undefined || price <= 0 || price >= 1) return null;

  const sizeShares = quantize(ctx, sizeUsd / price);
  if (sizeShares <= 0) return null;
  const outcome = action === "BUY_UP" ? "YES" : "NO";

  if (ctx.config.dryRun) {
    log(`DRY ${action} ${sizeShares} ${market.symbol} @ ~${price.toFixed(3)} (${agent.walletAddress})`);
    return { sizeShares, limitPrice: price, orderId: null, txHash: null };
  }

  const placed = await placeLimit(ctx, { market, onchain, outcome, side: "buy", price, size: sizeShares, type: "ioc" });
  if (placed.filled <= 0) return null;
  log(`${action} ${placed.filled} ${market.symbol} @ ~${placed.price.toFixed(3)} (${agent.walletAddress})`);
  return { sizeShares: placed.filled, limitPrice: placed.price, orderId: placed.orderId?.toString() ?? null, txHash: placed.hash ?? null };
}

// ec-core's own maybeClaim() throttles via a MODULE-LEVEL timestamp shared by
// every caller in the process ("one strategy, one wallet, one loop" — its own
// doc comment). With many per-agent wallets in one process that singleton
// would starve every wallet but the first each interval, so we throttle per
// agent here instead and call the lower-level claimSettled() directly.
const lastClaimAtMs = new Map<string, number>();

export async function maybeClaimForAgent(agent: Agent): Promise<void> {
  const privateKey = getAgentWalletPrivateKey(agent.id);
  if (!privateKey) return;
  const interval = Number(process.env.AUTO_CLAIM_INTERVAL_MS ?? 10 * 60_000);
  const last = lastClaimAtMs.get(agent.id) ?? 0;
  if (Date.now() - last < interval) return;
  lastClaimAtMs.set(agent.id, Date.now());

  const ctx = getAgentExchange(agent.id, privateKey);
  try {
    await claimSettled(ctx, { scan: Number(process.env.CLAIM_SCAN ?? 25) });
  } catch (e) {
    log(`claim failed for ${agent.walletAddress}: ${(e as Error).message}`);
  }
}
