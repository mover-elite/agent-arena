// User accounts (identified by wallet address), their LLM provider
// preference, and their encrypted API keys. Sessions are opaque bearer
// tokens issued after a successful SIWE-style signature verification
// (see auth.ts) — no passwords anywhere in this app.

import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { decryptSecret, encryptSecret, newOpaqueToken } from "./crypto-secrets.js";
import type { LlmCredentials, LlmProviderName, User } from "./types.js";

interface UserRow {
  id: string;
  address: string;
  display_name: string | null;
  llm_provider: LlmProviderName | null;
  anthropic_api_key_enc: string | null;
  anthropic_model: string | null;
  gemini_api_key_enc: string | null;
  gemini_model: string | null;
  created_at: string;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    address: r.address as `0x${string}`,
    displayName: r.display_name,
    llmProvider: r.llm_provider,
    anthropicModel: r.anthropic_model,
    geminiModel: r.gemini_model,
    hasAnthropicKey: r.anthropic_api_key_enc !== null,
    hasGeminiKey: r.gemini_api_key_enc !== null,
    createdAt: r.created_at,
  };
}

/** Wallet address is the identity — first sign-in creates the account. */
export function getOrCreateUserByAddress(address: `0x${string}`): User {
  const lower = address.toLowerCase() as `0x${string}`;
  const existing = db.prepare(`SELECT * FROM users WHERE address = ?`).get(lower) as UserRow | undefined;
  if (existing) return rowToUser(existing);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, address, created_at) VALUES (?, ?, ?)`).run(id, lower, createdAt);
  return {
    id,
    address: lower,
    displayName: null,
    llmProvider: null,
    anthropicModel: null,
    geminiModel: null,
    hasAnthropicKey: false,
    hasGeminiKey: false,
    createdAt,
  };
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

export interface ProfileUpdate {
  displayName?: string;
  llmProvider?: LlmProviderName;
  anthropicApiKey?: string; // empty string clears it
  anthropicModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
}

export function updateProfile(id: string, update: ProfileUpdate): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (update.displayName !== undefined) {
    sets.push("display_name = ?");
    values.push(update.displayName.trim().slice(0, 60) || null);
  }
  if (update.llmProvider !== undefined) {
    sets.push("llm_provider = ?");
    values.push(update.llmProvider);
  }
  if (update.anthropicApiKey !== undefined) {
    sets.push("anthropic_api_key_enc = ?");
    values.push(update.anthropicApiKey === "" ? null : encryptSecret(update.anthropicApiKey));
  }
  if (update.anthropicModel !== undefined) {
    sets.push("anthropic_model = ?");
    values.push(update.anthropicModel.trim() || null);
  }
  if (update.geminiApiKey !== undefined) {
    sets.push("gemini_api_key_enc = ?");
    values.push(update.geminiApiKey === "" ? null : encryptSecret(update.geminiApiKey));
  }
  if (update.geminiModel !== undefined) {
    sets.push("gemini_model = ?");
    values.push(update.geminiModel.trim() || null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** Resolves the credentials a user's agents should reason with, or null if
 *  they haven't configured a key for their selected provider yet. */
export function getUserLlmCredentials(id: string): LlmCredentials | null {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  if (!row || !row.llm_provider) return null;
  if (row.llm_provider === "anthropic") {
    if (!row.anthropic_api_key_enc) return null;
    return { provider: "anthropic", apiKey: decryptSecret(row.anthropic_api_key_enc), model: row.anthropic_model ?? undefined };
  }
  if (!row.gemini_api_key_enc) return null;
  return { provider: "gemini", apiKey: decryptSecret(row.gemini_api_key_enc), model: row.gemini_model ?? undefined };
}

// Sessions expire, and are slid forward on use (so an active user isn't
// logged out mid-session) but not on every single request — the refresh only
// fires once the session is past its halfway point, to keep the write rate
// near zero under the UI's 5s polling.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 7 * 24 * 60 * 60_000);

export function createSession(userId: string): string {
  const token = newOpaqueToken();
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    token,
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
  );
  return token;
}

export function getUserIdForToken(token: string): string | undefined {
  const row = db.prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(token) as
    | { user_id: string; expires_at: string | null }
    | undefined;
  if (!row) return undefined;
  const now = Date.now();
  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (!expiresAtMs || expiresAtMs <= now) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return undefined;
  }
  if (expiresAtMs - now < SESSION_TTL_MS / 2) {
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(new Date(now + SESSION_TTL_MS).toISOString(), token);
  }
  return row.user_id;
}

export function deleteSession(token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

/**
 * Revoke every session for a user. Pass `exceptToken` to keep the caller's
 * current session (a "log out my other devices" from the settings screen);
 * omit it for a full "log out everywhere". Returns how many rows were removed.
 */
export function deleteSessionsForUser(userId: string, exceptToken?: string): number {
  const stmt = exceptToken
    ? db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token != ?`)
    : db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
  const info = exceptToken ? stmt.run(userId, exceptToken) : stmt.run(userId);
  return info.changes;
}
