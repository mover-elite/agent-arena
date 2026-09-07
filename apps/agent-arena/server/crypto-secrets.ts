// Symmetric encryption for user-supplied LLM API keys at rest. Not a KMS —
// appropriate for a hackathon-scale single-process app, not a production
// secrets story — but plaintext-in-SQLite would be strictly worse, so this
// is the floor, not the ceiling.
//
// A KEY RING, newest first. New secrets are always encrypted with ring[0];
// decryption tries each key in order (AES-GCM's auth tag makes a wrong key an
// unambiguous failure), so rotating SESSION_ENCRYPTION_KEY doesn't orphan
// anything already stored. Sources, in priority order:
//   1. SESSION_ENCRYPTION_KEY            (64 hex = 32 bytes) — the primary key
//   2. logs/.session-secret              — the previous default; kept as a
//                                          fallback so pre-rotation data still reads
//   3. SESSION_ENCRYPTION_KEYS_LEGACY    — comma-separated old keys you want to
//                                          keep able to decrypt
// If nothing is configured, a key is generated and persisted to .session-secret
// (unchanged original behaviour).

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_PATH = process.env.AGENT_ARENA_SECRET_PATH ?? join(process.cwd(), "logs", ".session-secret");
const HEX32 = /^[0-9a-f]{64}$/i;

function buildKeyRing(): Buffer[] {
  const ring: Buffer[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const h = raw.trim().toLowerCase();
    if (HEX32.test(h) && !seen.has(h)) {
      seen.add(h);
      ring.push(Buffer.from(h, "hex"));
    }
  };

  const fromEnv = (process.env.SESSION_ENCRYPTION_KEY ?? "").trim();
  if (fromEnv) {
    if (!HEX32.test(fromEnv)) throw new Error("SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
    add(fromEnv);
  }
  if (existsSync(SECRET_PATH)) add(readFileSync(SECRET_PATH, "utf8"));
  for (const k of (process.env.SESSION_ENCRYPTION_KEYS_LEGACY ?? "").split(",")) add(k);

  if (ring.length === 0) {
    const key = randomBytes(32);
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    writeFileSync(SECRET_PATH, key.toString("hex"), { mode: 0o600 });
    ring.push(key);
  }
  return ring;
}

let cachedRing: Buffer[] | undefined;
function keyRing(): Buffer[] {
  if (!cachedRing) cachedRing = buildKeyRing();
  return cachedRing;
}

/** Returns `ivHex:tagHex:ciphertextHex`, encrypted with the primary (newest) key. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyRing()[0]!, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const [ivHex, tagHex, encHex] = blob.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("malformed secret blob");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  let lastErr: unknown;
  for (const k of keyRing()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", k, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch (e) {
      lastErr = e; // wrong key for this blob — try the next one
    }
  }
  throw new Error(`decrypt failed against all ${keyRing().length} key(s): ${(lastErr as Error)?.message ?? "unknown"}`);
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}
