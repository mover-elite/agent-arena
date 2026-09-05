# agent-arena — an AI agent builder for DreamDEX Event Contracts

Anyone connects a wallet, picks a ready-made strategy from the gallery or
describes one in plain English, and gives that agent its own LLM API key;
Agent Arena spins up an agent that trades **for real on testnet** from its own
dedicated wallet — no simulated/paper mode, no toggle. Two kinds of agent:

- **LLM** (default) — every cycle it sends the strategy prompt + live order-book
  data to an LLM, which returns a fair Up-probability + reasoning per market.
  Flexible; costs credits per cycle (heavily gated — see LLM spend control).
- **Coded** — at creation an LLM writes the agent a pure `decide(market, params, lib)`
  function *once*, from the description; every cycle after that the runtime
  executes it in a `worker_threads` sandbox — **zero per-cycle LLM cost**. The
  generated code, a plain-English explanation, and tunable parameters are all
  shown on the agent page; the owner can tune the params live or regenerate
  from a new description. `server/strategy-gen.ts` + `server/code-runner.ts`.
  - **Prebuilt coded presets** — `GET /api/code-presets` lists hand-authored
    `decide()` strategies ported from the kit's own bots (`strategies/`):
    **Oracle Follower** (moneyness-vs-strike + momentum drift, from
    ec-oracle-follow), **Underlying Momentum**, **Oversold Bounce** (RSI +
    Bollinger, two-sided), **Range Fader**. `POST /api/agents { codePresetId }`
    creates a coded agent with that code pre-loaded — **no LLM key, no generation
    call** — then it runs in the sandbox every cycle like any coded agent, and
    the params are tunable on the agent page. `server/strategy-code-presets.ts`.

There's a short "provisioning" window right after creation (the
treasury funds the new wallet with gas, then it mints its own trading
collateral via the SDK's testnet faucet) before an agent places its first
real order. Every decision — including every HOLD — is logged with the
model's reasoning, so the leaderboard's "why did it trade" feed is the
actual audit trail, not a summary of one.

Reasoning credentials are **per agent**: every agent carries its own LLM key
(set when you create it), and there is no shared or account-level fallback —
a user-owned agent with no key simply can't reason. The only exception is the
two optional seeded flagship agents (`SEED_FLAGSHIP_AGENTS=true`, off by
default), which have no owner and use the platform `.env` key. So one agent's rate limit or billing issue never blocks another's — not
even two owned by the same person — and the platform operator never pays for
anyone's LLM calls. Verified empirically, not just by code review: an agent
created with a deliberately invalid key produced its own distinct auth error
in the logs while the others (on working keys) kept running unaffected.

This is the [Somnia × DreamDEX Event Contracts Hackathon](https://dorahacks.io/hackathon/event-contracts/detail) submission built in this fork — see [What it targets](#what-it-targets-in-the-judging) below for how each piece maps to the rubric.

```bash
npm run dev -w agent-arena       # market loop + API + UI on :8787
```

Open `http://localhost:8787/`. **Pages**: `/` is the landing page, `/how.html` the mechanic walkthrough, `/app.html` the live board (dashboard + create flow), `/agent.html?id=` an agent's feed + performance, `/duel.html` a head-to-head, `/account.html` your profile. Every in-app page has a footer showing the exact risk gates and cadence the engine is running with right now (from `GET /api/config`) — nothing about how an agent decides is a black box.

## Accounts

Sign-in is wallet-based (SIWE-style: sign a server-issued nonce, no password
or email) — either a real injected wallet (`window.ethereum`, `personal_sign`)
or a pasted testnet private key signed **locally in the browser** via viem
(never transmitted). First sign-in creates the account. `/account.html` only
holds a display name — reasoning keys don't live at the account level.

Agents a signed-in user creates are owned by them (`owner_user_id` on the
`agents` table). **Every agent carries its own reasoning key**, set at create
time (`llm_api_key_enc` on the `agents` row — AES-256-GCM via `crypto-secrets.ts`,
the same helper wallets use; never returned by any API — only a `hasOwnLlmKey`
boolean and the provider name are). There is **no account-level or shared
fallback**: a user-owned agent with no key can't reason (it fails closed to
HOLD), and only the two optional seeded flagships (Momentum Max, Fade the
Crowd — no owner, `SEED_FLAGSHIP_AGENTS=true`) use the platform `.env` key. Owners rotate an agent's key via
`PATCH /api/agents/:id`. So credit usage isolates per *agent*: one agent's
rate-limit or billing problem can't touch another's, even two owned by the
same person.

## Wallets

Every agent — platform-owned or user-owned — gets its own dedicated testnet
EOA the moment it's created (`agent-wallet.ts`, `generateWallet()`), stored
encrypted the same way user API keys are. It starts unfunded ("provisioning"
in the UI); `agent-engine.ts` provisions it lazily on its first eligible
cycle rather than blocking creation on an on-chain confirmation: the
platform's own `PRIVATE_KEY` (the "treasury") drips it a little native gas,
then the agent's own wallet mints its own trading collateral via the SDK's
testnet faucet (`trader.faucet()`) — real, not assumed; verified against the
SDK's own type definitions. If funding fails (treasury too low, RPC hiccup),
the agent just stays "provisioning" and the next cycle tries again
automatically — no separate retry mechanism needed. From then on that agent
trades, claims, and settles entirely through its own wallet, for real,
permanently — there's no mode to toggle back from.

This is a one-wallet-per-agent design on purpose, not one-wallet-per-user or
one-shared-platform-wallet: Event Contracts have no session-key/operator
path the way spot trading does (`docs/session-keys.md`), so whoever holds a
wallet's key has full custody, and multiple agents sharing one wallet would
need cross-agent order-netting to avoid self-matching each other (an earlier
version of this app built exactly that, and it worked, but per-agent wallets
make the whole problem disappear — on-chain positions map 1:1 to internal
records, no attribution math, no shared-wallet risk between agents at all).
`MAX_CONCURRENT_LIVE_AGENTS` caps how many agents can be funded/trading at
once, protecting the treasury's gas balance from a burst of new agents all
provisioning around the same time.

**Scope note**: this is testnet-only by design, not a placeholder for
mainnet. Custodying a real key server-side is fine when it only ever holds
worthless testnet tokens; doing the same for mainnet funds would be a
fundamentally different liability (real money, many users, an unaudited
hackathon codebase), and the hackathon's own submission requirement is a
testnet prototype anyway — mainnet support isn't planned.

## Env (root `.env` — see `.env.example`'s `agent-arena` section)

- `LLM_PROVIDER`, `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `GEMINI_API_KEY`/`GEMINI_MODEL` — the **platform's own** credentials, used only by the two seeded flagship agents (the only ones with no owner). `LLM_PROVIDER` picks which one (`anthropic` default or `gemini`). Every other agent brings its own key (see Accounts above), so most of the fleet never touches these. Gemini keys come free (no billing/KYC) from [aistudio.google.com](https://aistudio.google.com); Anthropic needs billing/identity verification at console.anthropic.com, separate from any claude.ai subscription. The Gemini path uses `@google/genai`'s Interactions API (`ai.interactions.create`), verified against the installed package's own type definitions rather than assumed from memory, since the SDK surface has moved a few times.
- `SESSION_ENCRYPTION_KEY` — optional; 64 hex chars (32 bytes) to control the key used to encrypt stored user API keys. Auto-generated and persisted to `logs/.session-secret` if unset.
- **LLM spend control** — reasoning is the only real cost, so it's gated four ways, cheapest check first (`llm-cache.ts` + `llm-budget.ts`, all env-tunable): `CYCLE_INTERVAL_MS` (default **60s**) sets the base cadence; `SKIP_UNCHANGED_THRESHOLD` (default **0.02**) / `FORCE_REEVALUATE_MS` (default **15 min**) skip the call unless a watched market actually moved ≥2pp or went stale; a cooldown pre-filter skips it when the agent is inside its trade cooldown on every market (it couldn't act anyway); and `LLM_MIN_CALL_INTERVAL_MS` (default **120s**) + `LLM_MAX_CALLS_PER_DAY` (default **200/agent**) are hard floors/ceilings volatility can't beat. Per-agent keys mean each agent only ever spends its owner's budget; `GET /api/config` and every page footer show the live gates, and each agent's `llmBudget.callsToday` is on the leaderboard API. The dashboard's own liveness comes from a separate 5s price-feed loop (`PRICE_FEED_INTERVAL_MS`) that makes zero LLM calls.
- `PRIVATE_KEY` / `NETWORK` / `VENUE_ID` / `DRY_RUN` — the usual `ec-core` vars. `PRIVATE_KEY` here is the **treasury** that funds new agent wallets with gas (see Wallets above) and reasons for the platform-owned seeded agents — it is not the wallet any agent actually trades from. Fund it at [testnet.somnia.network](https://testnet.somnia.network).
- `AGENT_WALLET_GAS_STT` — how much native token the treasury drips to a newly-live agent's wallet (default `2`). Must stay above ~0.6: the markets-SDK signs every write with a fixed 10M-gas × 60-gwei ceiling, so the node reserves ~0.6 native per tx up front even though real gas is far less — a smaller drip gets the agent's faucet/order transactions rejected pre-execution.
- `CYCLE_INTERVAL_MS`, `WATCHLIST` — how often the shared market loop runs, and which underlyings (`BTC`, `ETH`) it watches.
- `MAX_POSITION_PER_MARKET_USD`, `MAX_CYCLE_NOTIONAL_USD`, `DAILY_LOSS_CAP_USD`, `MIN_CONFIDENCE_THRESHOLD`, `MIN_EDGE_THRESHOLD`, `TRADE_COOLDOWN_MS` — risk gates every trade goes through.
- `MAX_CONCURRENT_LIVE_AGENTS` — cap on how many agents can be funded/trading at once (protects the treasury, see Wallets above).
- `REASONING_RECEIPTS_ENABLED`, `REASONING_REGISTRY_ADDRESS` — on-chain reasoning receipts (off by default). When on, every actionable decision's reasoning hash is committed via the treasury wallet (as a relayer — never touches trading funds); the confirmed tx is written back as a `receipt` record in the JSONL log and shown as a "⛓ verified on-chain" badge on that decision in the UI. Needs a funded `PRIVATE_KEY` for gas; `ReasoningRegistry.sol` deploys itself on first commit unless an address is pinned. Verify with `npm run verify:live -- --receipts`.

## How it works

1. **`market-loop.ts`** — one shared per-cycle snapshot (order book, implied Up probability, time-to-expiry) of the watchlisted markets. `ec-core` has no candle feed for binary markets, so recent price history is our own rolling buffer.
2. **`agent-engine.ts`** — per agent, per cycle: first `ensureFunded()` provisions the wallet if it isn't yet (see Wallets), then `ensureCodeGenerated()` (coded agents only — the one-time LLM call that writes `decide()`, mirroring the lazy-provision pattern; on failure the agent parks with a visible `codeError` and does **not** retry the paid call every cycle). Then this cycle's per-market calls are produced one of two ways:
   - **coded agent** — `buildCodeMarketViews()` assembles a plain-object view (order book + real underlying 1m candles + the opening/strike price + longer history), and `code-runner.ts` runs the stored `decide()` in a `worker_threads` sandbox (static-reject pass → frozen inputs → hard `terminate()` timeout). A throw / timeout / bad return becomes a logged `HOLD` with `skipReason: "code_error"`. **No LLM spend gates run for coded agents — they make zero per-cycle calls.**
   - **LLM agent** — the spend gates run in order: `llm-cache.ts` (`needsFreshCall`), a cooldown pre-filter, `llm-budget.ts` (`checkBudget`); if all pass, `llm-decide.ts` resolves credentials and dispatches to `llm-providers/anthropic.ts` / `gemini.ts`.

   Either way the result is `LlmMarketCall[]`, and from there the path is identical: `risk.ts` gates it (confidence/edge thresholds, cooldown, notional caps, daily loss cap) and an approved trade executes for real against the agent's own wallet (`live-executor.ts`).
3. **`live-executor.ts`** / **`agent-wallet.ts`** — `executeLiveTrade` places a real IOC order for one agent against its own `EcContext` (no cross-agent netting needed — every agent has its own wallet, see Wallets); `maybeClaimForAgent` sweeps that agent's settled winnings, throttled per-agent in-process (ec-core's own `maybeClaim()` throttles via one process-wide timestamp meant for a single-wallet bot, which would starve every wallet but the first in a multi-wallet process, so this calls the lower-level `claimSettled()` directly instead).
4. **`settlement-reconciler.ts`** — once a market referenced by an open position resolves on-chain, computes the real payout (winner pays 1 − settlement fee), closes the position, and logs a `settlement` record with a Brier-score component scoring the original probability call against the real outcome.
5. **`decision-log.ts`** — append-only JSONL per agent (`logs/<agentId>/decisions-YYYY-MM-DD.jsonl`), the audit trail the UI and `scripts/evaluate.ts` both read. **`agents-store.ts`**/**`users-store.ts`** (SQLite, shared connection in `db.ts`) is the operational state: agent registry + ownership, user accounts, encrypted keys, sessions, open/closed positions, cooldowns.
6. **`auth.ts`** / **`api/auth.ts`** — SIWE-style nonce issuance and signature verification (viem's `recoverMessageAddress`, fully offline — no RPC call), opaque bearer-token sessions with a sliding TTL (`SESSION_TTL_MS`, default 7 days; refreshed on use once past half-life, expired rows pruned on read). `POST /api/auth/nonce`, `POST /api/auth/verify`, `POST /api/auth/logout`, `POST /api/auth/logout-all` (revoke every session for the account; `?keepCurrent=1` spares the caller's), `GET/PATCH /api/me`. Setting or rotating an account LLM key via `PATCH /api/me` revokes the account's other sessions automatically (privilege-change rotation). Nonce/verify are rate-limited per IP (`AUTH_ATTEMPTS_PER_MIN`, default 20).
7. **`reasoning-registry.ts`** — when receipts are enabled, `commitReasoningNow()` deploys/loads `ReasoningRegistry.sol`, commits `keccak256(decision)` on-chain, and appends a `receipt` log record (tx hash + registry address + the decision's cycle id) that the feed matches back to its decision row.
8. **`api/agents.ts`** — public, CORS-open read API: `GET /api/agents` (leaderboard, includes each agent's owner and `isFunded` status), `GET /api/agents/:id` (profile + reasoning feed + `isOwner` for the caller), `GET /api/duel?a=&b=` (head-to-head), `GET /api/agents/:id/card.svg` (shareable stats card), `GET /api/strategy-presets` (the curated LLM-prompt gallery), `GET /api/code-presets` (the prebuilt coded-strategy gallery), `GET /api/config` (live engine knobs). Each agent row also carries `llmKey: {provider, source}` — how it resolves its reasoning credentials (`agent` / `platform` / `none`), no secret. Write endpoints (session required): `POST /api/agents` (create — `{name, strategyPrompt}` or `{presetId}`, an optional `{kind: "code"}`, **plus a required `{llmProvider, llmApiKey}` (`llmModel` optional)** — used every cycle by an LLM agent, or once by a coded agent to write its logic; **or `{codePresetId}` for a prebuilt coded strategy — no key required**), `PATCH /api/agents/:id` (owner-only — rotate the key, or `{params}` to tune a coded agent, sandbox-validated before it persists), `POST /api/agents/:id/regenerate` (owner-only — rewrite a coded agent's `decide()` from a new `{description}`, inline), and `POST /api/agents/:id/dry-run` (owner-only — run a coded agent's current code against the latest snapshots and return what it *would* decide; no trade). `GET /api/agents/:id` adds `strategyKind`, `isGenerating`, `codeError`, `generatedSpec`/`generatedParams`, and `generatedCode` (owner only). Write endpoints are rate-limited: `POST /api/agents` caps held agents per account (`MAX_AGENTS_PER_USER`, default 12) and spawn rate (`AGENT_CREATES_PER_HOUR`, default 6, counted on success — each agent provisions a wallet + treasury gas drip); `/regenerate` has a per-agent cooldown (`REGEN_COOLDOWN_MS`, default 45s — it's a live LLM call); `/dry-run` is `DRYRUN_PER_MIN` (default 8) per agent. All return `429` + `Retry-After`. Limiter is `server/rate-limit.ts` — in-memory, per-process.

9. **`strategy-presets.ts`** — six ready-made strategies (Momentum Rider, Fade the Crowd, Range Fader, Late Convergence, Spread Sniper, Conservative Value). The create form on `/app.html` shows them as a gallery: pick one to fill the prompt box, tweak, create — or write your own from scratch. The two optional seeded flagship agents (`SEED_FLAGSHIP_AGENTS=true`) draw their prompts from this list, so there's one source of truth for what a good EC strategy prompt looks like.
10. **`api/dashboard.ts`** — the live board.'s read model, all derived from state the engine already writes (`market-state.ts` + JSONL + SQLite). `GET /api/markets` (+ per-card underlying price/strike), `GET /api/markets/:id/detail` (candles + per-trade markers, each tagged `settled`/`outcome`/`pnlUsd`/`brier` by matching the opening decision's `cycleId` to its settlement; resolves asset + timing from the audit log when a market has rolled out of the live set, so `?market=<id>` deep-links still draw), `GET /api/activity`, `GET /api/positions` (the trade ledger — every open + settled position with side, size @ entry, cost, and realised P&L/return, plus a fleet summary), `GET /api/overview`, `GET /api/underlying`. The dashboard renders a **Positions** panel (Pending / Settled / All), and each agent page a **Performance** card (cumulative-P&L curve, win rate / profit factor / avg win-loss / best-worst, a calibration plot of predicted vs actual Up-rate by probability bucket, and a BTC-vs-ETH breakdown) — all computed client-side from the feed, no new endpoint.

`npm run evaluate -w agent-arena` prints a per-agent calibration report (hit rate and Brier score by confidence decile) from the accumulated logs.

Read [`docs/event-contracts.md`](../../docs/event-contracts.md) and [`docs/session-keys.md`](../../docs/session-keys.md) before touching `agent-wallet.ts`/`live-executor.ts` — the second one explains why session keys *aren't* used here (that feature is spot-only), which is the whole reason this app custodies a real key per agent instead.

## What it targets in the judging

| Criterion | How |
| --- | --- |
| Innovation & Originality | Not one more trading bot — a platform where anyone connects a wallet, picks a strategy from the gallery or writes one in plain English, optionally gives that agent its own LLM key, and gets a real agent on a public leaderboard with a duel view (`duel.html`) showing two agents' live reasoning head-to-head on the same market. |
| Technical Implementation | Real use of `@dreamdex-bot-kit/ec-core` for market discovery/status-gating, tick-safe order placement, settlement claiming, and the testnet collateral faucet — end-to-end verified live (`npm run verify:live`); a dedicated encrypted wallet generated per agent, provisioned lazily and self-healing on retry (Event Contracts have no session-key/operator path, unlike spot — see `docs/session-keys.md`/Wallets above); a deployed on-chain `ReasoningRegistry.sol` whose receipts thread back into the UI; a required, encrypted, per-agent LLM key (no shared/account fallback — an agent's spend can't touch another's); wallet-based auth with offline signature verification and a sliding session TTL, no third-party auth provider. |
| UX & Design | No mode to configure or misunderstand — every agent trades for real from creation, with an honest "provisioning…" status until its wallet is funded; every page shows the live engine config so nothing is a black box; large, unmuted reasoning text in the feed rather than a truncated summary; sign-in works with or without a browser wallet extension. |
| Business & Ecosystem Impact | A public, CORS-open, no-auth read API (`/api/agents`, `/api/duel`, `/api/agents/:id/card.svg`, `/api/strategy-presets`) other builders can embed without touching this UI; per-agent API keys mean the platform operator never foots the LLM bill as the user base grows — the cost model actually scales. |
| Presentation & Demo | The share-card endpoint and the duel view exist specifically to give the demo video concrete, visual moments beyond "here's a leaderboard." |

## Verifying the live path

Wallet provisioning (treasury gas drip → faucet mint), live order placement, and on-chain
reasoning receipts are code-complete and typechecked. They also have a one-command
end-to-end check against a real testnet — run it once with a funded treasury key:

```bash
npm run verify:live -w agent-arena                    # provisioning + market discovery
npm run verify:live -w agent-arena -- --trade         # + one tiny real IOC + a claim sweep
npm run verify:live -w agent-arena -- --receipts      # + deploy ReasoningRegistry.sol + commit one hash
npm run verify:live -w agent-arena -- --trade --receipts --yes
```

It generates a throwaway agent wallet, runs it through the exact `provisionAgentWallet()`
path the engine uses, confirms the drip and faucet mint landed on-chain, lists the venue's
tradable markets, and (with the flags) places a real IOC and commits a real receipt —
printing a PASS/FAIL checklist and a non-zero exit code on any failure. Testnet only; it
refuses to run against mainnet. Fund the treasury at [testnet.somnia.network](https://testnet.somnia.network).

First run on 2026-09-02 went 9/9 (real fill `0xb35f31d8…`, receipt `0xaa6a81e9…`) after two
config fixes it surfaced, both now defaulted/documented:

- **`AGENT_WALLET_GAS_STT` ≥ ~0.6** — the markets-SDK reserves 10M gas × 60 gwei per write
  up front; a 0.5 drip got faucet/order txns rejected pre-execution. Default is now `2`.
- **`MM_TICK` / `MM_LOT` = 1000** — ec-core's testnet default `lot=1` is stale; the live
  venue enforces `lot == tick == 1000` and reverts an off-grid order size (`0x4f174b29`).
  Set both in `.env` (see `.env.example`).

## Hosting

Agent Arena is **one always-on Node process** — an in-process market loop, a WebSocket tail to the
venue, the HTTP API + static UI, and a SQLite file that is the source of truth for accounts, agents,
positions, and sessions.

- **Not serverless** (there's no request to wake on), and **one instance only** — SQLite, the
  in-memory rate limiters, and the market loop are all process-local.
- **Persist state across restarts:** point `AGENT_ARENA_DB_PATH`, `AGENT_ARENA_LOG_DIR`, and
  `AGENT_ARENA_SECRET_PATH` at a volume, and set `SESSION_ENCRYPTION_KEY` explicitly. The SQLite file
  holds every account + agent (including encrypted per-agent wallet keys) — back it up.
- Run it wherever you keep a long-lived container alive (`restart: unless-stopped` / a process
  manager). `better-sqlite3` is the only native dependency; on a minimal base image install
  `python3 make g++` and `npm rebuild better-sqlite3`.

Before creating agents, fund the treasury address (derived from `PRIVATE_KEY`) at
[testnet.somnia.network](https://testnet.somnia.network).

## Known gaps as of this build

- **Coded agents**: the sandbox path is verified end-to-end (`npm run test:code-runner` — 10
  cases incl. infinite-loop kill + heap-spin containment; a seeded coded agent provisioned,
  ran its `decide()` every cycle, logged decisions with **0 LLM budget calls**). The four
  **prebuilt coded presets** are exercised end-to-end with no LLM key at all
  (`npm run test:code-presets` — 32 cases: static gate, populated-market run, empty-market
  abstain, param extremes, directional sanity; plus a live `POST {codePresetId}` → create →
  `PATCH {params}` → dry-run round-trip).
- **LLM-*generated* coded agents**: the *generation* call's provider plumbing, error handling,
  retry, and the validate-and-dry-run acceptance path are tested (`npm run test:strategy-gen
  -- --offline` — 5 cases), but a real LLM producing valid code hasn't been run here — both
  test keys are out of credits/quota. Fund a key and create a coded agent *from a description*
  (not a preset) to close that. If generation fails, the agent parks with a visible
  `codeError` and never trades on garbage.
- The full unattended provision→trade→settle→claim→receipt loop **has been watched end-to-end
  across a market's entire lifecycle** (over the ~minutes a binary window takes to expire), in
  addition to the step-wise `verify:live` checks.
- The "sign in with a browser wallet" path (`window.ethereum` / `personal_sign`) **has been
  tested in a real browser**. The pasted-testnet-key path and the whole server-side auth flow
  (nonce issuance, replay rejection, forged-signature rejection, session lifetime) were already
  verified via a simulated-wallet script against the real endpoints.
- Sessions carry a sliding TTL (`SESSION_TTL_MS`, default 7 days), a `POST /api/auth/logout-all` (revoke all, optionally sparing the caller), and automatic revoke-others when an account LLM key is set/rotated via `PATCH /api/me`. There's still no UI surface for "log out everywhere" and no session-binding to IP/UA.
- **`crypto-secrets.ts` is single-process, hackathon-grade** (AES-256-GCM with a key auto-generated to `logs/.session-secret` if `SESSION_ENCRYPTION_KEY` is unset — noted in-file). Fine for this submission; a production deploy wants a real KMS/secret manager and a multi-process-safe store.

### Shipped this build

Prebuilt coded-strategy presets (`GET /api/code-presets`, `POST /api/agents {codePresetId}` — no LLM key); the **Positions** panel + `GET /api/positions` trade ledger; the agent-page **Performance** card (P&L curve, win rate / profit factor, calibration plot, BTC-vs-ETH split); settled-vs-open trade markers on the featured chart (hollow = settled, tinted by win/loss) with a per-market trade list; `?market=<id>` deep-links now resolve asset + timing from the audit log so an already-settled market still renders; and per-account / per-agent / per-IP rate limits (`server/rate-limit.ts`) on agent creation, `/regenerate`, `/dry-run`, and auth.
