// Spend control for agent reasoning. `llm-cache.ts` already skips a call when
// nothing an agent watches has moved; this adds hard ceilings so a volatile
// market can't run the bill up regardless:
//
//   • a per-agent MIN INTERVAL between calls — a volatility-proof floor;
//   • a per-agent DAILY CALL CAP — a hard stop (agent HOLDs once exhausted).
//
// In memory only, keyed by agentId. A process restart grants a fresh budget —
// generous by design, not a leak; make the caps the source of truth, not
// uptime. Per-agent keys mean each agent/user is only ever spending their own.

const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_CALL_INTERVAL_MS ?? 120_000); // ≤ 1 call / 2 min / agent
const MAX_PER_DAY = Number(process.env.LLM_MAX_CALLS_PER_DAY ?? 200); // hard ceiling / agent / UTC day

interface AgentBudget {
  day: string; // UTC yyyy-mm-dd the count belongs to
  calls: number;
  lastCallAt: number;
}

const budgets = new Map<string, AgentBudget>();

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function get(agentId: string): AgentBudget {
  let b = budgets.get(agentId);
  const today = utcDay();
  if (!b || b.day !== today) {
    b = { day: today, calls: 0, lastCallAt: 0 };
    budgets.set(agentId, b);
  }
  return b;
}

export interface BudgetCheck {
  allowed: boolean;
  reason: "min_interval" | "daily_cap" | null;
}

/** May this agent make an LLM call right now? */
export function checkBudget(agentId: string): BudgetCheck {
  const b = get(agentId);
  if (b.calls >= MAX_PER_DAY) return { allowed: false, reason: "daily_cap" };
  if (MIN_INTERVAL_MS > 0 && Date.now() - b.lastCallAt < MIN_INTERVAL_MS) return { allowed: false, reason: "min_interval" };
  return { allowed: true, reason: null };
}

/** Record that a real LLM call just happened for this agent. */
export function recordCall(agentId: string): void {
  const b = get(agentId);
  b.calls += 1;
  b.lastCallAt = Date.now();
}

export interface BudgetSnapshot {
  callsToday: number;
  maxPerDay: number;
  minIntervalMs: number;
  nextEligibleInMs: number;
}

export function budgetSnapshot(agentId: string): BudgetSnapshot {
  const b = get(agentId);
  return {
    callsToday: b.calls,
    maxPerDay: MAX_PER_DAY,
    minIntervalMs: MIN_INTERVAL_MS,
    nextEligibleInMs: Math.max(0, MIN_INTERVAL_MS - (Date.now() - b.lastCallAt)),
  };
}

/** Total LLM calls across every agent seen since the process started, today. */
export function fleetCallsToday(): number {
  const today = utcDay();
  let n = 0;
  for (const b of budgets.values()) if (b.day === today) n += b.calls;
  return n;
}

export function budgetConfig(): { maxPerDay: number; minIntervalMs: number } {
  return { maxPerDay: MAX_PER_DAY, minIntervalMs: MIN_INTERVAL_MS };
}
