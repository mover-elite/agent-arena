// Symmetric encryption for user-supplied LLM API keys at rest. Not a KMS —
// appropriate for a hackathon-scale single-process app, not a production
// secrets story — but plaintext-in-SQLite would be strictly worse, so this
// is the floor, not the ceiling.
//
// The encryption key is generated once and persisted alongside the rest of
// this app's local state (logs/.session-secret, already gitignored via
// logs/) so stored keys survive a restart without requiring another env var.
// Override with SESSION_ENCRYPTION_KEY (64 hex chars = 32 bytes) if you want
// to manage it yourself (e.g. a Railway secret).

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_PATH = process.env.AGENT_ARENA_SECRET_PATH ?? join(process.cwd(), "logs", ".session-secret");

function loadOrCreateKey(): Buffer {
  const fromEnv = (process.env.SESSION_ENCRYPTION_KEY ?? "").trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error("SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
    return Buffer.from(fromEnv, "hex");
  }
  if (existsSync(SECRET_PATH)) return Buffer.from(readFileSync(SECRET_PATH, "utf8").trim(), "hex");
  const key = randomBytes(32);
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, key.toString("hex"), { mode: 0o600 });
  return key;
}

let cachedKey: Buffer | undefined;
function key(): Buffer {
  if (!cachedKey) cachedKey = loadOrCreateKey();
  return cachedKey;
}

/** Returns `ivHex:tagHex:ciphertextHex`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const [ivHex, tagHex, encHex] = blob.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("malformed secret blob");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}
