// Single shared SQLite handle + full schema, so agents-store.ts and
// users-store.ts operate on one database and one set of migrations rather
// than each opening their own connection.

import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.AGENT_ARENA_DB_PATH ?? join(process.cwd(), "logs", "agent-arena.sqlite");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy_prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',
  virtual_balance_usd REAL NOT NULL,
  best_pnl_usd REAL NOT NULL DEFAULT 0,
  owner_user_id TEXT,
  wallet_address TEXT,
  wallet_private_key_enc TEXT,
  wallet_funded_at TEXT,
  llm_provider TEXT,
  llm_api_key_enc TEXT,
  llm_model TEXT,
  strategy_kind TEXT NOT NULL DEFAULT 'llm',
  generated_code TEXT,
  generated_params TEXT,
  generated_spec TEXT,
  code_error TEXT,
  code_generated_at TEXT,
  paused_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  outcome TEXT NOT NULL,
  size_shares REAL NOT NULL,
  entry_price REAL NOT NULL,
  cost_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  fair_up_probability REAL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  realized_pnl_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_agent_status ON positions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id, status);

CREATE TABLE IF NOT EXISTS last_trade (
  agent_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (agent_id, market_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  llm_provider TEXT,
  anthropic_api_key_enc TEXT,
  anthropic_model TEXT,
  gemini_api_key_enc TEXT,
  gemini_model TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// CREATE TABLE IF NOT EXISTS skips a table that already exists from an
// earlier version of this schema — add columns introduced since then here.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("agents", "best_pnl_usd", `best_pnl_usd REAL NOT NULL DEFAULT 0`);
ensureColumn("agents", "owner_user_id", `owner_user_id TEXT`);
ensureColumn("agents", "wallet_address", `wallet_address TEXT`);
ensureColumn("agents", "wallet_private_key_enc", `wallet_private_key_enc TEXT`);
ensureColumn("agents", "wallet_funded_at", `wallet_funded_at TEXT`);
ensureColumn("agents", "llm_provider", `llm_provider TEXT`);
ensureColumn("agents", "llm_api_key_enc", `llm_api_key_enc TEXT`);
ensureColumn("agents", "llm_model", `llm_model TEXT`);
ensureColumn("agents", "strategy_kind", `strategy_kind TEXT NOT NULL DEFAULT 'llm'`);
ensureColumn("agents", "generated_code", `generated_code TEXT`);
ensureColumn("agents", "generated_params", `generated_params TEXT`);
ensureColumn("agents", "generated_spec", `generated_spec TEXT`);
ensureColumn("agents", "code_error", `code_error TEXT`);
ensureColumn("agents", "code_generated_at", `code_generated_at TEXT`);
ensureColumn("agents", "paused_at", `paused_at TEXT`);
ensureColumn("sessions", "expires_at", `expires_at TEXT`);

// Indexes that reference a migrated-in column must run after the migration above.
db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id);`);

// Sessions predating the TTL column have expires_at = NULL — treat those as
// already expired on next use rather than immortal. One-time cleanup so a
// stale NULL row can't linger forever.
db.prepare(`DELETE FROM sessions WHERE expires_at IS NULL`).run();
db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
