// SQLite-backed operational state: agent registry, open/closed positions,
// per-market trade cooldown timestamps. This is the source of truth the
// engine reads/writes every cycle; the JSONL log (decision-log.ts) is the
// narrative/audit trail the dashboard tails.
// Schema + shared connection live in db.ts; user accounts live in users-store.ts.

import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto-secrets.js";
import { generateWallet } from "./agent-wallet.js";
import type {
  Agent,
  AgentMode,
  GeneratedStrategySpec,
  LlmCredentials,
  LlmProviderName,
  StrategyKind,
} from "./types.js";
import type { Hex } from "viem";

// Agents created before per-agent wallets existed have no wallet on record —
// generate one now so every agent really does have a real address (the Agent
// type promises walletAddress is never null).
function backfillMissingWallets(): void {
  const rows = db.prepare(`SELECT id FROM agents WHERE wallet_address IS NULL`).all() as { id: string }[];
  for (const row of rows) {
    const wallet = generateWallet();
    db.prepare(`UPDATE agents SET wallet_address = ?, wallet_private_key_enc = ? WHERE id = ?`).run(
      wallet.address,
      encryptSecret(wallet.privateKey),
      row.id,
    );
  }
}
backfillMissingWallets();

// Agents created before paper mode was removed are still marked 'paper' in
// the DB — nothing branches on it any more, but leaving stale data in an API
// response is just confusing, so normalize it once.
db.prepare(`UPDATE agents SET mode = 'live' WHERE mode != 'live'`).run();

interface AgentRow {
  id: string;
  name: string;
  strategy_prompt: string;
  mode: AgentMode;
  virtual_balance_usd: number;
  owner_user_id: string | null;
  wallet_address: string;
  wallet_funded_at: string | null;
  llm_provider: LlmProviderName | null;
  llm_api_key_enc: string | null;
  llm_model: string | null;
  strategy_kind: string;
  generated_code: string | null;
  generated_params: string | null;
  generated_spec: string | null;
  code_error: string | null;
  code_generated_at: string | null;
  paused_at: string | null;
  created_at: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    strategyPrompt: r.strategy_prompt,
    mode: r.mode,
    virtualBalanceUsd: r.virtual_balance_usd,
    ownerUserId: r.owner_user_id,
    walletAddress: r.wallet_address as `0x${string}`,
    createdAt: r.created_at,
    hasOwnLlmKey: r.llm_api_key_enc !== null,
    ownLlmProvider: r.llm_api_key_enc !== null ? r.llm_provider : null,
    strategyKind: r.strategy_kind === "code" ? "code" : "llm",
    generatedCode: r.generated_code,
    generatedParams: parseJson<Record<string, number | boolean>>(r.generated_params),
    generatedSpec: parseJson<GeneratedStrategySpec>(r.generated_spec),
    codeError: r.code_error,
    codeGeneratedAt: r.code_generated_at,
    pausedAt: r.paused_at,
  };
}

export interface AgentLlmKeyInput {
  provider: LlmProviderName;
  apiKey: string;
  model?: string;
}

// No paper/simulated mode: every agent trades real testnet orders from its
// own wallet, funded lazily on its first eligible cycle (agent-engine.ts).
// startingBalanceUsd is a soft sizing-cap input for risk.ts, not a tracked
// balance — it's set to roughly what the testnet faucet mints, not adjusted
// per-trade; ec-core's own funded-balance check is the real backstop.
export function createAgent(
  name: string,
  strategyPrompt: string,
  ownerUserId: string | null,
  opts: { startingBalanceUsd?: number; llm?: AgentLlmKeyInput; kind?: StrategyKind } = {},
): Agent {
  const startingBalanceUsd = opts.startingBalanceUsd ?? 10_000;
  const kind: StrategyKind = opts.kind === "code" ? "code" : "llm";
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const wallet = generateWallet();
  const llmProvider = opts.llm?.provider ?? null;
  const llmKeyEnc = opts.llm ? encryptSecret(opts.llm.apiKey) : null;
  const llmModel = opts.llm?.model?.trim() || null;
  db.prepare(
    `INSERT INTO agents (id, name, strategy_prompt, mode, virtual_balance_usd, owner_user_id, wallet_address, wallet_private_key_enc, llm_provider, llm_api_key_enc, llm_model, strategy_kind, created_at)
     VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    strategyPrompt,
    startingBalanceUsd,
    ownerUserId,
    wallet.address,
    encryptSecret(wallet.privateKey),
    llmProvider,
    llmKeyEnc,
    llmModel,
    kind,
    createdAt,
  );
  return {
    id,
    name,
    strategyPrompt,
    mode: "live",
    virtualBalanceUsd: startingBalanceUsd,
    ownerUserId,
    walletAddress: wallet.address,
    createdAt,
    hasOwnLlmKey: llmKeyEnc !== null,
    ownLlmProvider: llmKeyEnc !== null ? llmProvider : null,
    strategyKind: kind,
    generatedCode: null,
    generatedParams: null,
    generatedSpec: null,
    codeError: null,
    codeGeneratedAt: null,
    pausedAt: null,
  };
}

/** Switch an agent between "llm" (reasons every cycle) and "code" (sandboxed
 *  decide()). Caller handles generating / clearing the code. */
export function setStrategyKind(agentId: string, kind: "llm" | "code"): void {
  db.prepare(`UPDATE agents SET strategy_kind = ? WHERE id = ?`).run(kind, agentId);
}

/** Pause or resume an agent (owner action). A paused agent skips its decision
 *  cycle; its positions still settle and its history is untouched. */
export function setAgentPaused(agentId: string, paused: boolean): void {
  db.prepare(`UPDATE agents SET paused_at = ? WHERE id = ?`).run(paused ? new Date().toISOString() : null, agentId);
}

/** Permanently remove an agent and everything scoped to it. The dedicated
 *  wallet keeps whatever testnet balance it holds — this only forgets the key. */
export function deleteAgent(agentId: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM positions WHERE agent_id = ?`).run(agentId);
    db.prepare(`DELETE FROM last_trade WHERE agent_id = ?`).run(agentId);
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(agentId);
  });
  tx();
}

// ── Generated-strategy state (for `"code"` agents) ─────────────────────────

export interface GeneratedStrategy {
  code: string;
  params: Record<string, number | boolean>;
  spec: GeneratedStrategySpec;
}

/** The code + current params + spec, or null if it hasn't been generated yet. */
export function getGeneratedStrategy(agentId: string): GeneratedStrategy | null {
  const row = db
    .prepare(`SELECT generated_code, generated_params, generated_spec FROM agents WHERE id = ?`)
    .get(agentId) as { generated_code: string | null; generated_params: string | null; generated_spec: string | null } | undefined;
  if (!row?.generated_code) return null;
  const spec = parseJson<GeneratedStrategySpec>(row.generated_spec);
  const params = parseJson<Record<string, number | boolean>>(row.generated_params);
  if (!spec || !params) return null;
  return { code: row.generated_code, params, spec };
}

/** Write any subset of the generated strategy. Any write clears `code_error`. */
export function setGeneratedStrategy(
  agentId: string,
  partial: { code?: string; params?: Record<string, number | boolean>; spec?: GeneratedStrategySpec },
): void {
  const sets: string[] = ["code_error = NULL"];
  const vals: unknown[] = [];
  if (partial.code !== undefined) {
    sets.push("generated_code = ?");
    vals.push(partial.code);
  }
  if (partial.params !== undefined) {
    sets.push("generated_params = ?");
    vals.push(JSON.stringify(partial.params));
  }
  if (partial.spec !== undefined) {
    sets.push("generated_spec = ?");
    vals.push(JSON.stringify(partial.spec));
  }
  vals.push(agentId);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function setCodeError(agentId: string, message: string): void {
  db.prepare(`UPDATE agents SET code_error = ? WHERE id = ?`).run(message.slice(0, 2000), agentId);
}

export function markCodeGenerated(agentId: string): void {
  db.prepare(`UPDATE agents SET code_generated_at = ?, code_error = NULL WHERE id = ?`).run(
    new Date().toISOString(),
    agentId,
  );
}

export function getCodeGeneratedAt(agentId: string): string | null {
  const row = db.prepare(`SELECT code_generated_at FROM agents WHERE id = ?`).get(agentId) as
    | { code_generated_at: string | null }
    | undefined;
  return row?.code_generated_at ?? null;
}

/** Reset a `"code"` agent so it re-generates on its next cycle (used before an inline regenerate). */
export function clearGeneratedCode(agentId: string): void {
  db.prepare(
    `UPDATE agents SET generated_code = NULL, generated_params = NULL, generated_spec = NULL, code_generated_at = NULL, code_error = NULL WHERE id = ?`,
  ).run(agentId);
}

/** Update the natural-language description an agent's strategy comes from. */
export function setStrategyPrompt(agentId: string, prompt: string): void {
  db.prepare(`UPDATE agents SET strategy_prompt = ? WHERE id = ?`).run(prompt, agentId);
}

/** This agent's OWN reasoning credentials, decrypted — engine use only
 *  (llm-decide.ts). Never returned from any API. null when the agent has no
 *  key; a user-owned agent then can't reason (there is no account fallback). */
export function getAgentLlmCredentials(agentId: string): LlmCredentials | null {
  const row = db.prepare(`SELECT llm_provider, llm_api_key_enc, llm_model FROM agents WHERE id = ?`).get(agentId) as
    | { llm_provider: LlmProviderName | null; llm_api_key_enc: string | null; llm_model: string | null }
    | undefined;
  if (!row?.llm_api_key_enc || !row.llm_provider) return null;
  return { provider: row.llm_provider, apiKey: decryptSecret(row.llm_api_key_enc), model: row.llm_model ?? undefined };
}

/** Set, replace, or clear (`llm: null`) an agent's own reasoning key. */
export function setAgentLlmCredentials(agentId: string, llm: AgentLlmKeyInput | null): void {
  db.prepare(`UPDATE agents SET llm_provider = ?, llm_api_key_enc = ?, llm_model = ? WHERE id = ?`).run(
    llm?.provider ?? null,
    llm ? encryptSecret(llm.apiKey) : null,
    llm?.model?.trim() || null,
    agentId,
  );
}

/** Decrypted — for the engine's own use only (agent-wallet.ts, live execution,
 *  claiming). Never returned from any API response. */
export function getAgentWalletPrivateKey(agentId: string): Hex | undefined {
  const row = db.prepare(`SELECT wallet_private_key_enc FROM agents WHERE id = ?`).get(agentId) as
    | { wallet_private_key_enc: string | null }
    | undefined;
  if (!row?.wallet_private_key_enc) return undefined;
  return decryptSecret(row.wallet_private_key_enc) as Hex;
}

export function isWalletFunded(agentId: string): boolean {
  const row = db.prepare(`SELECT wallet_funded_at FROM agents WHERE id = ?`).get(agentId) as
    | { wallet_funded_at: string | null }
    | undefined;
  return Boolean(row?.wallet_funded_at);
}

export function markWalletFunded(agentId: string): void {
  db.prepare(`UPDATE agents SET wallet_funded_at = ? WHERE id = ?`).run(new Date().toISOString(), agentId);
}

export function getAgent(id: string): Agent | undefined {
  const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : undefined;
}

export function listAgents(): Agent[] {
  const rows = db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`).all() as AgentRow[];
  return rows.map(rowToAgent);
}

/** How many agents currently have a funded wallet. */
export function countFundedAgents(): number {
  const row = db.prepare(`SELECT COUNT(*) as n FROM agents WHERE wallet_funded_at IS NOT NULL`).get() as { n: number };
  return row.n;
}

export interface Position {
  id: string;
  agentId: string;
  marketId: string;
  symbol: string;
  outcome: "YES" | "NO";
  sizeShares: number;
  entryPrice: number;
  costUsd: number;
  status: "open" | "settled";
  mode: AgentMode;
  cycleId: string;
  fairUpProbability: number | null;
  openedAt: string;
  closedAt: string | null;
  realizedPnlUsd: number | null;
}

interface PositionRow {
  id: string;
  agent_id: string;
  market_id: string;
  symbol: string;
  outcome: "YES" | "NO";
  size_shares: number;
  entry_price: number;
  cost_usd: number;
  status: "open" | "settled";
  mode: AgentMode;
  cycle_id: string;
  fair_up_probability: number | null;
  opened_at: string;
  closed_at: string | null;
  realized_pnl_usd: number | null;
}

function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    agentId: r.agent_id,
    marketId: r.market_id,
    symbol: r.symbol,
    outcome: r.outcome,
    sizeShares: r.size_shares,
    entryPrice: r.entry_price,
    costUsd: r.cost_usd,
    status: r.status,
    mode: r.mode,
    cycleId: r.cycle_id,
    fairUpProbability: r.fair_up_probability,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    realizedPnlUsd: r.realized_pnl_usd,
  };
}

export function openPosition(p: {
  agentId: string;
  marketId: string;
  symbol: string;
  outcome: "YES" | "NO";
  sizeShares: number;
  entryPrice: number;
  costUsd: number;
  mode: AgentMode;
  cycleId: string;
  fairUpProbability: number | null;
}): Position {
  const id = randomUUID();
  const openedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO positions (id, agent_id, market_id, symbol, outcome, size_shares, entry_price, cost_usd, status, mode, cycle_id, fair_up_probability, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    id,
    p.agentId,
    p.marketId,
    p.symbol,
    p.outcome,
    p.sizeShares,
    p.entryPrice,
    p.costUsd,
    p.mode,
    p.cycleId,
    p.fairUpProbability,
    openedAt,
  );
  return { id, status: "open", openedAt, closedAt: null, realizedPnlUsd: null, ...p };
}

export function getOpenPositions(marketId?: string): Position[] {
  const rows = marketId
    ? (db.prepare(`SELECT * FROM positions WHERE status = 'open' AND market_id = ?`).all(marketId) as PositionRow[])
    : (db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all() as PositionRow[]);
  return rows.map(rowToPosition);
}

/** Every position, newest first — open ones first, then settled by close time. */
export function listAllPositions(limit = 500): Position[] {
  const rows = db
    .prepare(
      `SELECT * FROM positions
       ORDER BY (status = 'open') DESC,
                COALESCE(closed_at, opened_at) DESC
       LIMIT ?`,
    )
    .all(limit) as PositionRow[];
  return rows.map(rowToPosition);
}

export function closePosition(id: string, realizedPnlUsd: number): void {
  db.prepare(`UPDATE positions SET status = 'settled', closed_at = ?, realized_pnl_usd = ? WHERE id = ?`).run(
    new Date().toISOString(),
    realizedPnlUsd,
    id,
  );
}

export function getLastTradeAtMs(agentId: string, marketId: string): number | undefined {
  const row = db.prepare(`SELECT ts FROM last_trade WHERE agent_id = ? AND market_id = ?`).get(agentId, marketId) as
    | { ts: number }
    | undefined;
  return row?.ts;
}

export function setLastTradeAtMs(agentId: string, marketId: string, ts: number): void {
  db.prepare(
    `INSERT INTO last_trade (agent_id, market_id, ts) VALUES (?, ?, ?)
     ON CONFLICT(agent_id, market_id) DO UPDATE SET ts = excluded.ts`,
  ).run(agentId, marketId, ts);
}

export function getDailyPnlUsd(agentId: string): number {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_usd), 0) as pnl FROM positions WHERE agent_id = ? AND status = 'settled' AND closed_at >= ?`,
    )
    .get(agentId, sinceIso) as { pnl: number };
  return row.pnl;
}

export function getBestPnlUsd(agentId: string): number {
  const row = db.prepare(`SELECT best_pnl_usd FROM agents WHERE id = ?`).get(agentId) as { best_pnl_usd: number } | undefined;
  return row?.best_pnl_usd ?? 0;
}

/** Called after a settlement changes an agent's realized P&L. Returns true
 *  when this is a new personal best — the UI's cue to offer a share card. */
export function bumpBestPnlIfHigher(agentId: string, currentPnlUsd: number): boolean {
  const best = getBestPnlUsd(agentId);
  if (currentPnlUsd <= best) return false;
  db.prepare(`UPDATE agents SET best_pnl_usd = ? WHERE id = ?`).run(currentPnlUsd, agentId);
  return true;
}

export function getAgentPnlUsd(agentId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl_usd), 0) as pnl FROM positions WHERE agent_id = ? AND status = 'settled'`)
    .get(agentId) as { pnl: number };
  return row.pnl;
}
