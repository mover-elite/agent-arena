// Tiny in-memory sliding-window rate limiter. Single-process only (this app is
// one process); good enough to stop a signed-in session or a single IP from
// hammering the wallet-provisioning / LLM / auth paths. No dependency, no store.

interface Window {
  hits: number[]; // ms timestamps, ascending
}

const windows = new Map<string, Window>();

/**
 * Record one hit for `key` and report whether it's allowed under `limit` per
 * `windowMs`. When blocked, `retryAfterMs` is how long until the oldest hit
 * ages out. `limit = 1` gives a plain cooldown.
 */
export function hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const w = windows.get(key) ?? { hits: [] };
  // drop expired
  while (w.hits.length && w.hits[0]! <= cutoff) w.hits.shift();

  if (w.hits.length >= limit) {
    windows.set(key, w);
    const retryAfterMs = Math.max(0, (w.hits[0] ?? now) + windowMs - now);
    return { ok: false, retryAfterMs };
  }
  w.hits.push(now);
  windows.set(key, w);
  return { ok: true, retryAfterMs: 0 };
}

/** Check `key` against the window WITHOUT recording a hit (for pre-validation). */
export function peek(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const w = windows.get(key);
  if (!w) return { ok: true, retryAfterMs: 0 };
  while (w.hits.length && w.hits[0]! <= now - windowMs) w.hits.shift();
  if (w.hits.length >= limit) return { ok: false, retryAfterMs: Math.max(0, (w.hits[0] ?? now) + windowMs - now) };
  return { ok: true, retryAfterMs: 0 };
}

/** Best-effort client IP for keying unauthenticated limits. */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0]!.trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// Opportunistic cleanup so the map can't grow unbounded under churn.
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) {
    while (w.hits.length && w.hits[0]! <= now - 3_600_000) w.hits.shift();
    if (w.hits.length === 0) windows.delete(k);
  }
}, 600_000).unref();
