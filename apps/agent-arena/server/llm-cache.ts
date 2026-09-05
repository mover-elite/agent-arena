// Credit-saving optimization: skip the LLM call entirely when nothing an
// agent is watching has actually changed since its last evaluation. In
// memory only (losing it on restart just costs one extra call per agent,
// not a correctness issue) — keyed by agentId -> marketId -> last look.

import type { LlmMarketCall, MarketSnapshot } from "./types.js";

const MOVE_THRESHOLD = Number(process.env.SKIP_UNCHANGED_THRESHOLD ?? 0.02); // only re-reason on a ≥2pp move
const FORCE_REEVALUATE_MS = Number(process.env.FORCE_REEVALUATE_MS ?? 15 * 60_000); // …or once every 15 min regardless

interface CacheEntry {
  yesMid: number | undefined;
  ts: number;
  call: LlmMarketCall | null;
}

const cache = new Map<string, Map<string, CacheEntry>>();

function agentCache(agentId: string): Map<string, CacheEntry> {
  let m = cache.get(agentId);
  if (!m) {
    m = new Map();
    cache.set(agentId, m);
  }
  return m;
}

/** True if at least one watched market has moved enough (or gone stale
 *  enough, or is new) to be worth a fresh LLM call this cycle. */
export function needsFreshCall(agentId: string, snapshots: MarketSnapshot[]): boolean {
  const entries = agentCache(agentId);
  const now = Date.now();
  for (const s of snapshots) {
    const prior = entries.get(s.marketId);
    if (!prior) return true;
    if (now - prior.ts >= FORCE_REEVALUATE_MS) return true;
    if (prior.yesMid === undefined || s.yesMid === undefined) return true;
    if (Math.abs(s.yesMid - prior.yesMid) >= MOVE_THRESHOLD) return true;
  }
  return false;
}

/** Record this cycle's outcome for every watched market, whether or not the
 *  model actually returned a call for it (a market it stayed silent on still
 *  counts as "looked at just now" for staleness purposes). */
export function recordCycle(agentId: string, snapshots: MarketSnapshot[], calls: LlmMarketCall[]): void {
  const entries = agentCache(agentId);
  const callByMarket = new Map(calls.map((c) => [c.marketId, c]));
  const now = Date.now();
  for (const s of snapshots) {
    entries.set(s.marketId, { yesMid: s.yesMid, ts: now, call: callByMarket.get(s.marketId) ?? null });
  }
}
