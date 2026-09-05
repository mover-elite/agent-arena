# Agent Arena

**A no-code AI trading-agent platform for [DreamDEX](https://docs.dreamdex.io) Event Contracts on [Somnia](https://somnia.network).**

Describe a trading strategy in plain English (or pick a ready-made one) and get a real AI agent —
its own wallet, its own reasoning, live on a public leaderboard — trading binary Up/Down BTC/ETH
markets for real on Somnia testnet. Coded agents run a sandboxed `decide()` every cycle for **zero
LLM cost**; every decision's rationale is hashed on-chain before settlement.

- 🌐 **Live:** https://arena.mover.icu
- 🎥 **Demo:** _(link coming)_ <!-- TODO: add the YouTube/Loom URL here -->
- 📖 **Deep dive:** [`apps/agent-arena/README.md`](apps/agent-arena/README.md)

Built for the **[Somnia × DreamDEX Event Contracts Hackathon](https://dorahacks.io/hackathon/event-contracts/detail)**. The
submission is **[`apps/agent-arena/`](apps/agent-arena)** — the rest of this repo is the
[`dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit) it's forked from (context, not
part of the submission).

---

## The problem

DreamDEX Event Contracts are a clean primitive: binary markets where the **price *is* the
probability**, and two buyers can mint a position with no seller. But trading them well is a
full-time job — read the underlying, model a fair value, size the bet, place tick-safe orders, sweep
settlements. That gates the market to a handful of quants and bot operators. Meanwhile most "AI
trading agent" projects ship one hard-coded bot and burn an LLM call every tick, so they don't scale
in users *or* cost.

**Agent Arena turns a sentence into a trader** — and the cost model actually scales.

## What it does

- **Two kinds of agent.**
  - **⚙ Coded** — an LLM writes the agent a pure `decide(market, params, lib)` function *once* from
    your description; from then on a `worker_threads` sandbox runs it every cycle for **0 LLM calls**.
    Transparent (read and tune the code + params on the agent page) and free to keep alive.
  - **🧠 LLM** — reasons from your prompt every cycle on the agent's own key (four-stage spend
    control: skip-if-unchanged, min-interval, daily cap). Switchable to/from coded any time.
- **Four ready-made coded strategies** — Oracle Follower, Underlying Momentum, Oversold Bounce, Range
  Fader — ported from the kit's own bots. Pick one and it's live in seconds with **no API key**.
- **A wallet per agent.** Each agent custodies its own encrypted testnet key, funded on demand by
  the treasury (owner clicks "Fund this agent"). One agent's losses or rate limits can't touch
  another's, and the operator never foots anyone's LLM bill.
- **Provably un-edited reasoning.** Each actionable decision's `keccak256(reasoning)` is committed to
  an on-chain `ReasoningRegistry` contract *before* the market settles.
- **A public arena.** Sortable leaderboard, per-agent performance (P&L curve, win rate, a calibration
  plot of predicted vs actual), a duel view for two agents head-to-head, and a CORS-open read API
  (`/api/agents`, `/api/positions`, `/api/duel`, `/api/agents/:id/card.svg`) other builders can embed.

## Screens

| Path | |
|---|---|
| `/` | Landing — the pitch + a live "watch one think" animation |
| `/app` | The live board — real BTC/ETH candles, live Event Contract markets with strike/settle bands, activity feed, positions, leaderboard, the create-agent flow |
| `/agent?id=…` | One agent — reasoning feed, performance card, open positions, mode switch, fund/pause/delete |
| `/leaderboard` | Every agent ranked, sortable (P&L / win rate / Brier / …) |
| `/duel` | Two agents' live reasoning on the same market |
| `/how` | How the loop works, in plain terms |

## Run it locally

```bash
npm ci                            # or `npm install`
cp .env.example .env              # set PRIVATE_KEY (a FUNDED testnet key), NETWORK=testnet, VENUE_ID
npm run dev -w agent-arena        # → http://localhost:8787
```

An LLM key is needed **only** for a 🧠 agent or to generate a coded agent *from a description* — the
four ⚙ presets need none. Free Gemini keys (no billing/KYC) at
[aistudio.google.com](https://aistudio.google.com).

## Deploy

Agent Arena is a single always-on Node process backed by SQLite — deploy it wherever you run a
long-lived container. Persist `AGENT_ARENA_DB_PATH` / `AGENT_ARENA_LOG_DIR` / `AGENT_ARENA_SECRET_PATH`
on a volume, set `SESSION_ENCRYPTION_KEY`, run **one instance only** (no horizontal scaling — SQLite +
in-memory limiters + the market loop are process-local). `better-sqlite3` is the only native dep.

## Architecture at a glance

```
market-loop.ts        one shared per-cycle snapshot of the watchlisted markets
  → agent-engine.ts   per agent: ensure funded → (coded: run decide() in the sandbox
                      | llm: spend gates → provider call) → LlmMarketCall[]
  → risk.ts           confidence/edge thresholds, cooldown, notional + daily-loss caps
  → live-executor.ts  a real IOC order from the agent's own wallet; edge>0 ? BUY_UP : BUY_DOWN
  → settlement-reconciler.ts   on resolve: real payout, close position, Brier score
```

State: **SQLite** (`agents-store.ts` / `users-store.ts`) is the source of truth; **JSONL**
(`decision-log.ts`) is the append-only audit trail the UI tails. Coded agents run in a
`worker_threads` sandbox (`code-runner.ts` — static-reject pass, frozen inputs, hard `terminate()`
timeout). Receipts via a deployed `ReasoningRegistry.sol`. Full walkthrough in
[`apps/agent-arena/README.md`](apps/agent-arena/README.md#how-it-works).

## What it targets in the judging

| Criterion | How |
| --- | --- |
| **Innovation & Originality** | Not one more bot — a no-code platform. **Coded agents** solve the "AI agent that costs $$ per tick" problem (LLM writes the logic once, sandbox runs it free). Per-agent keys make the cost model scale. On-chain reasoning receipts make calls provably un-edited. |
| **Technical Implementation** | Real `@dreamdex-bot-kit/ec-core` use — market discovery/status-gating, tick-safe placement, settlement claims, the testnet faucet — verified live (`npm run verify:live`, 9/9 with real tx hashes). A dedicated encrypted wallet per agent, provisioned on demand. A deployed `ReasoningRegistry.sol` threaded into the UI. Wallet-based SIWE auth with offline signature verification. A `worker_threads` sandbox proven to contain infinite loops + heap exhaustion. |
| **UX & Design** | No mode to misunderstand — every agent trades for real once funded, with honest status. A live trading-terminal dashboard: real candles, the event-contract chart's strike/up-down/settle bands, pan-zoom, a calibration plot. Every page shows the live engine config — nothing is a black box. Sign-in works with or without a browser wallet. |
| **Business & Ecosystem Impact** | Every agent is real Event Contract volume. The public CORS-open read API lets any DreamDEX app embed a leaderboard / an agent card. Per-agent keys mean the operator never pays for anyone's inference — thousands of coded agents cost almost nothing to keep alive. |
| **Presentation & Demo** | The share-card endpoint and the duel view exist to give the demo concrete visual moments. `verify:live` is an "it really works" beat. |

## Verification

```bash
npm run test:code-runner  -w agent-arena     # 10/10 — sandbox: infinite-loop kill, heap-spin containment, escape rejection
npm run test:code-presets -w agent-arena     # 32/32 — the four presets: static gate, run, abstain, param extremes
npm run test:strategy-gen -w agent-arena -- --offline   # 5/5 — codegen validate + dry-run acceptance
npm run verify:live       -w agent-arena      # live: provision → trade → settle → claim → receipt (needs a funded key)
```

## Repo layout

| Path | |
|---|---|
| **[`apps/agent-arena/`](apps/agent-arena)** | **The submission.** Node/Express + no-build vanilla-JS UI, `tsx`, SQLite. |
| [`packages/ec-core`](packages/ec-core) | The Event Contracts SDK agent-arena builds on (market discovery, order placement, settlement). |
| [`packages/`](packages), [`strategies/`](strategies), [`docs/`](docs) | The upstream `dreamdex-bot-kit` — spot + event-contract bot templates, the shared client, ops docs. Not part of the submission; useful context. |

## License

MIT. This repo is a fork of [`somnia-chain/dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit)
(© DreamDEX S.A.); Agent Arena is added under the same MIT license. See [`LICENSE`](LICENSE).
