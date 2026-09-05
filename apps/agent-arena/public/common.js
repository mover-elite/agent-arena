// Shared across index.html / agent.html / duel.html — no build step, so this
// is the one place markup helpers live instead of being copy-pasted three times.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Renders a compact transparency bar into `elId` from GET /api/config — the
 *  actual risk gates and cadence the engine is running with, not a claim. */
async function renderConfigFooter(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  try {
    const res = await fetch("/api/config");
    const c = await res.json();
    const netBadge = c.network === "mainnet" ? "MAINNET" : "testnet";
    const modeBadge = c.dryRun ? "dry-run" : "orders enabled";
    el.innerHTML = `
      <span title="Network this engine is configured against">${escapeHtml(netBadge)} · ${escapeHtml(modeBadge)}</span>
      <span title="Which LLM vendor is reasoning for every agent this run">🧠 ${escapeHtml(c.llmProvider)}</span>
      <span title="How often agents re-reason (LLM calls scale with this)">cycle ${Math.round(c.cycleIntervalMs / 1000)}s</span>
      ${c.llmBudget ? `<span title="Spend control: an agent skips the LLM call unless a market moved ≥${(c.llmBudget.skipUnchangedThreshold * 100).toFixed(0)}pp or ${Math.round(c.llmBudget.forceReevaluateMs / 60000)}min passed; never more than once per ${Math.round(c.llmBudget.minIntervalMs / 1000)}s; hard stop at ${c.llmBudget.maxPerDay}/day.">🧠 ≤ ${c.llmBudget.maxPerDay} calls/day/agent</span>` : ""}
      <span title="Underlyings the market loop watches">watching ${c.watchlist.map(escapeHtml).join(", ")}</span>
      <span title="A trade needs at least this much |model probability − market probability| to clear the risk gate">min edge ${(c.risk.minEdge * 100).toFixed(0)}pp</span>
      <span title="A trade needs at least this much model confidence to clear the risk gate">min confidence ${(c.risk.minConfidence * 100).toFixed(0)}%</span>
      <span title="Per-market cap on new risk taken per trade">cap $${c.risk.maxPositionPerMarketUsd}/market</span>
      <span title="Treasury burst guard: wallets it will fund per rolling hour. Funding is owner-triggered from the agent page.">${c.maxAgentFundsPerHour} funds/hr cap</span>
      ${c.reasoningReceiptsEnabled ? '<span title="Reasoning hashes are being committed on-chain">⛓ on-chain receipts on</span>' : ""}
    `;
  } catch {
    el.textContent = "engine config unavailable";
  }
}

// ── Auth: SIWE-style wallet sign-in, no passwords ───────────────────────────
// A signed-in session is a bearer token in localStorage. Two ways to sign the
// nonce: a real injected wallet (window.ethereum, personal_sign) if present,
// or a pasted testnet private key signed LOCALLY via viem loaded from a CDN
// — the key never leaves the browser, never touches our server.

const AUTH_TOKEN_KEY = "agentArenaToken";

function getToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}
function setToken(token) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // localStorage unavailable (private mode, etc.) — session just won't persist across reloads.
  }
}
function clearToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** fetch() with the bearer token attached when one exists. */
function authFetch(url, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...opts, headers });
}

async function fetchMe() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await authFetch("/api/me");
    if (!res.ok) {
      if (res.status === 401) clearToken();
      return null;
    }
    return (await res.json()).user;
  } catch {
    return null;
  }
}

async function signInWithInjectedWallet() {
  if (!window.ethereum) throw new Error("no browser wallet detected");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const { message } = await (await fetch("/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  })).json();
  const signature = await window.ethereum.request({ method: "personal_sign", params: [message, address] });
  return completeSignIn(address, signature);
}

/** Signs locally with a pasted testnet private key via viem loaded from a
 *  CDN — this page has no build step, and this is a real server-rendered
 *  page (not a sandboxed artifact), so a CDN ES module import is fine here.
 *  The key is used in-memory for one signature and never sent anywhere. */
async function signInWithLocalKey(privateKey) {
  const { privateKeyToAccount } = await import("https://esm.sh/viem@2/accounts");
  const key = privateKey.trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const { message } = await (await fetch("/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json();
  const signature = await account.signMessage({ message });
  return completeSignIn(account.address, signature);
}

async function completeSignIn(address, signature) {
  const res = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "sign-in failed");
  setToken(data.token);
  return data.user;
}

async function signOut() {
  try {
    await authFetch("/api/auth/logout", { method: "POST" });
  } catch {
    /* best effort */
  }
  clearToken();
}

/** Renders a compact "connect / account" control into `elId`. */
async function renderAuthNav(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const user = await fetchMe();
  if (!user) {
    el.innerHTML = `<button class="nav-connect" id="nav-connect-btn">Connect wallet</button>`;
    document.getElementById("nav-connect-btn").addEventListener("click", () => openConnectModal());
    return;
  }
  const label = user.displayName || `${user.address.slice(0, 6)}…${user.address.slice(-4)}`;
  el.innerHTML = `<a class="nav-account" href="/account.html">${escapeHtml(label)}</a>`;
}

function openConnectModal() {
  const hasInjected = Boolean(window.ethereum);
  const existing = document.getElementById("connect-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "connect-modal";
  modal.innerHTML = `
    <div class="connect-backdrop"></div>
    <div class="connect-box">
      <h3>Connect a wallet</h3>
      ${hasInjected ? `<button class="connect-option" id="connect-injected">Use browser wallet</button>` : `<div class="connect-hint">No browser wallet detected.</div>`}
      <div class="connect-or">or sign in with a testnet private key (signs locally, never sent anywhere)</div>
      <input type="password" id="connect-pk" placeholder="0x… testnet private key" />
      <button class="connect-option" id="connect-local">Sign in locally</button>
      <div class="connect-msg" id="connect-msg"></div>
      <button class="connect-cancel" id="connect-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(modal);
  document.querySelector(".connect-backdrop").addEventListener("click", () => modal.remove());
  document.getElementById("connect-cancel").addEventListener("click", () => modal.remove());
  const msg = document.getElementById("connect-msg");
  if (hasInjected) {
    document.getElementById("connect-injected").addEventListener("click", async () => {
      msg.textContent = "Check your wallet…";
      try {
        await signInWithInjectedWallet();
        modal.remove();
        location.reload();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }
  document.getElementById("connect-local").addEventListener("click", async () => {
    const pk = document.getElementById("connect-pk").value;
    if (!pk) return void (msg.textContent = "paste a private key first");
    msg.textContent = "Signing…";
    try {
      await signInWithLocalKey(pk);
      modal.remove();
      location.reload();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

// Shared styling for the connect modal + nav control, injected once so every
// page gets it without repeating a <style> block.
(function injectAuthStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .nav-connect, .nav-account {
      background: #1a1d26; color: #e6e8ee; border: 1px solid #2a3040; border-radius: 8px;
      padding: 0.45rem 0.9rem; font: inherit; font-size: 0.82rem; cursor: pointer; text-decoration: none; display: inline-block;
    }
    .nav-connect:hover, .nav-account:hover { border-color: #4d7cff; }
    #connect-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
    .connect-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }
    .connect-box {
      position: relative; background: #12151c; border: 1px solid #232733; border-radius: 12px;
      padding: 1.5rem; width: min(360px, 90vw); display: grid; gap: 0.75rem;
    }
    .connect-box h3 { margin: 0; font-size: 1.05rem; color: #e6e8ee; }
    .connect-option {
      background: #4d7cff; color: white; border: none; border-radius: 8px; padding: 0.6rem 1rem;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .connect-option:hover { background: #3d68e0; }
    .connect-or { font-size: 0.78rem; color: #8b93a7; }
    .connect-hint { font-size: 0.82rem; color: #8b93a7; }
    #connect-pk {
      width: 100%; background: #0b0d12; border: 1px solid #2a3040; border-radius: 8px; color: #e6e8ee;
      padding: 0.55rem 0.7rem; font: inherit; box-sizing: border-box;
    }
    .connect-msg { font-size: 0.8rem; color: #d9b45c; min-height: 1.1em; }
    .connect-cancel {
      background: transparent; color: #8b93a7; border: none; font: inherit; font-size: 0.8rem;
      cursor: pointer; justify-self: start; padding: 0;
    }
  `;
  document.head.appendChild(style);
})();

// data:-URI favicon — a small chart-like glyph, no asset file needed.
(function setFavicon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0d12"/><path d="M7 22 L13 14 L18 18 L25 8" stroke="#4d7cff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="8" r="2.5" fill="#5ce08a"/></svg>`;
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  document.head.appendChild(link);
})();
