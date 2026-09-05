// SIWE-style wallet auth: prove control of an address by signing a
// server-issued nonce, no passwords or email involved. Verification is pure
// offline signature recovery (viem's recoverMessageAddress) — no RPC call,
// so this works identically for a real injected wallet (personal_sign) or a
// testnet key signed locally in the browser.

import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { getUserIdForToken } from "./users-store.js";

const NONCE_TTL_MS = 5 * 60_000;
const nonces = new Map<string, { nonce: string; expiresAt: number }>();

export function issueNonce(address: string): { nonce: string; message: string } {
  const nonce = randomBytes(16).toString("hex");
  const key = address.toLowerCase();
  nonces.set(key, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  return { nonce, message: buildMessage(address, nonce) };
}

function buildMessage(address: string, nonce: string): string {
  return [
    "Agent Arena wants you to sign in with your wallet:",
    address,
    "",
    "This proves you control this address. It costs no gas and triggers no transaction.",
    "",
    `Nonce: ${nonce}`,
  ].join("\n");
}

/** Verifies a signature against the last nonce issued for this address, and
 *  consumes it (single use) regardless of outcome. */
export async function verifySignedNonce(address: `0x${string}`, signature: `0x${string}`): Promise<boolean> {
  const key = address.toLowerCase();
  const entry = nonces.get(key);
  nonces.delete(key); // single-use whether it checks out or not
  if (!entry || Date.now() > entry.expiresAt) return false;

  const message = buildMessage(address, entry.nonce);
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    return recovered.toLowerCase() === key;
  } catch {
    return false;
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
}

/** Required auth — 401s if there's no valid session. Sets res.locals.userId. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  const userId = token ? getUserIdForToken(token) : undefined;
  if (!userId) {
    res.status(401).json({ error: "sign in required" });
    return;
  }
  res.locals.userId = userId;
  next();
}

/** Optional auth — never rejects; sets res.locals.userId when a valid
 *  session is present, so a GET endpoint can include "isOwner" without
 *  requiring every caller to be signed in. */
export function attachUserIfPresent(req: Request, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token) {
    const userId = getUserIdForToken(token);
    if (userId) res.locals.userId = userId;
  }
  next();
}
