import { Router } from "express";
import { issueNonce, requireAuth, verifySignedNonce } from "../auth.js";
import { clientIp, hit } from "../rate-limit.js";
import { createSession, deleteSession, deleteSessionsForUser, getOrCreateUserByAddress, getUserById, updateProfile, type ProfileUpdate } from "../users-store.js";

const bearer = (req: { headers: { authorization?: string } }): string =>
  (req.headers.authorization ?? "").startsWith("Bearer ") ? req.headers.authorization!.slice("Bearer ".length).trim() : "";

export const authRouter = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Per-IP: 20 nonce/verify attempts per minute is plenty for a real login.
const AUTH_PER_MIN = Number(process.env.AUTH_ATTEMPTS_PER_MIN ?? 20);

function authThrottle(req: Parameters<typeof clientIp>[0], res: { status: (n: number) => { json: (b: unknown) => void }; setHeader: (k: string, v: string) => void }): boolean {
  const r = hit(`auth:${clientIp(req)}`, AUTH_PER_MIN, 60_000);
  if (!r.ok) {
    res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
    res.status(429).json({ error: "too many attempts — wait a moment and try again" });
    return false;
  }
  return true;
}

authRouter.post("/auth/nonce", (req, res) => {
  if (!authThrottle(req, res)) return;
  const address = req.body?.address;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    return void res.status(400).json({ error: "a valid 0x-address is required" });
  }
  res.json(issueNonce(address));
});

authRouter.post("/auth/verify", async (req, res) => {
  if (!authThrottle(req, res)) return;
  const address = req.body?.address;
  const signature = req.body?.signature;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    return void res.status(400).json({ error: "a valid 0x-address is required" });
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return void res.status(400).json({ error: "signature is required" });
  }
  const ok = await verifySignedNonce(address as `0x${string}`, signature as `0x${string}`);
  if (!ok) return void res.status(401).json({ error: "signature did not verify — request a fresh nonce and try again" });

  const user = getOrCreateUserByAddress(address as `0x${string}`);
  const token = createSession(user.id);
  res.json({ token, user });
});

authRouter.post("/auth/logout", requireAuth, (req, res) => {
  const t = bearer(req);
  if (t) deleteSession(t);
  res.json({ ok: true });
});

// "Log out everywhere" — revoke every session for this account. `?keepCurrent=1`
// keeps the calling session alive (log out my *other* devices).
authRouter.post("/auth/logout-all", requireAuth, (req, res) => {
  const keepCurrent = req.query.keepCurrent === "1" || req.body?.keepCurrent === true;
  const revoked = deleteSessionsForUser(res.locals.userId as string, keepCurrent ? bearer(req) : undefined);
  res.json({ ok: true, revoked });
});

authRouter.get("/me", requireAuth, (_req, res) => {
  const user = getUserById(res.locals.userId as string);
  if (!user) return void res.status(404).json({ error: "not found" });
  res.json({ user });
});

authRouter.patch("/me", requireAuth, (req, res) => {
  const body = req.body ?? {};
  const update: ProfileUpdate = {};
  if (typeof body.displayName === "string") update.displayName = body.displayName;
  if (body.llmProvider === "anthropic" || body.llmProvider === "gemini") update.llmProvider = body.llmProvider;
  if (typeof body.anthropicApiKey === "string") update.anthropicApiKey = body.anthropicApiKey;
  if (typeof body.anthropicModel === "string") update.anthropicModel = body.anthropicModel;
  if (typeof body.geminiApiKey === "string") update.geminiApiKey = body.geminiApiKey;
  if (typeof body.geminiModel === "string") update.geminiModel = body.geminiModel;

  updateProfile(res.locals.userId as string, update);

  // Privilege change (an API key was set/rotated) → drop this account's other
  // sessions so a stale device can't keep acting with the old credentials.
  const keyChanged = "anthropicApiKey" in update || "geminiApiKey" in update;
  if (keyChanged) deleteSessionsForUser(res.locals.userId as string, bearer(req));

  const user = getUserById(res.locals.userId as string);
  res.json({ user, otherSessionsRevoked: keyChanged });
});
