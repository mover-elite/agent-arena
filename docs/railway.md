# Deploy on Railway

Run a DreamDEX bot as an **always-on worker** on [Railway](https://railway.com) — no local Node install or VPS to babysit. This matches the [dreamBot Builder](https://app.dreamdex.io/dreambot-builder) flow: configure strategy and knobs in the UI, then deploy the generated env to Railway instead of cloning locally.

Your **private key never touches DreamDEX**; you paste it only into Railway service variables.

## Features showcased

- **Limit order** / **Market order** (via strategy templates in the kit)
- **Good-Till-Cancelled (GTC)** / strategy-specific behavior (see each strategy README)

## Learning outcome

You can run any of the six TypeScript builder strategies 24/7 on Railway with safe testnet + dry-run defaults, then flip to mainnet live trading when ready.

## Canonical docs

- [DreamDEX docs](https://docs.dreamdex.io/)
- [Getting started (wallet, funding)](getting-started.md)
- [Running 24/7](24-7-operations.md)
- [Session keys](session-keys.md) (optional; not automated on Railway)

---

## What gets deployed

One Railway **service** (worker):

- Builds from the repo [`Dockerfile`](../Dockerfile) (Node 20, npm workspaces, `@dreamdex-bot-kit/core` + strategies).
- Runs [`scripts/railway-start.mjs`](../scripts/railway-start.mjs) → `npm run start -w <STRATEGY>`.
- **No public HTTP** — the bot is a long-running process, not a web app.
- Restarts on failure (`ON_FAILURE` in [`railway.toml`](../railway.toml)).

---

## One-click template (publish checklist)

For DreamDEX maintainers publishing the template:

1. In Railway: **Workspace → Templates → New Template**.
2. Add a service sourced from `https://github.com/somnia-chain/dreamdex-bot-kit` (pin branch/tag as needed).
3. Railway picks up [`railway.toml`](../railway.toml) and the Dockerfile on deploy.
4. In the template **Variables** tab, paste the contents of [`.env.railway`](../.env.railway) via **RAW Editor** (all defaults except `PRIVATE_KEY`), then:
   - **`PRIVATE_KEY`** — mark **required**, leave default **empty** (user fills at deploy).
   - Or: deploy from GitHub first → **Variables → suggested import** from `.env.railway` → add empty required `PRIVATE_KEY` → **Generate Template from Project**.
5. **Do not** enable public networking for this service.
6. Create template, copy the share URL (e.g. `https://railway.com/deploy/...`).
7. Paste that URL into `docs/railway.md` under **Template URL** once live.
8. Optional: [publish to the marketplace](https://docs.railway.com/templates/publish-and-share).

The Docker image also copies `.env.railway` → `.env`, so a service with **only** `PRIVATE_KEY` set in Railway still gets every other default at runtime.

### Template URL (demo / test)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/_qTYwR?referralCode=2yBRe7&utm_medium=integration&utm_source=template&utm_campaign=generic)

Deploy link: https://railway.com/deploy/_qTYwR?referralCode=2yBRe7&utm_medium=integration&utm_source=template&utm_campaign=generic

Set **`PRIVATE_KEY`** at deploy time; other defaults come from the template / [`.env.railway`](../.env.railway).

---

## User flow

1. Open the template → **Deploy**.
2. Set **`PRIVATE_KEY`** (`0x…`; MetaMask exports without `0x` — the start script adds it and logs once).
3. Set **`STRATEGY`** and tuning vars (or keep defaults).
4. Deploy → open **Logs** and confirm dry-run lines look right.
5. Connect the **same wallet** on [Algo Arena](https://app.dreamdex.io/dreambot-builder) so volume counts.
6. When ready for real trading: set `NETWORK=mainnet`, `DRY_RUN=false` in Railway variables and redeploy.

Fund the bot wallet (SOMI for gas + tokens for the market). See [Getting started § Fund the bot](getting-started.md#4-fund-the-bot).

---

## Environment variables

Canonical defaults for Railway live in [`.env.railway`](../.env.railway) (committed, no `PRIVATE_KEY`). Import that file in the Railway UI or rely on the baked-in `.env` in the Docker image.

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| `PRIVATE_KEY` | Yes | — | Set only in Railway; never in `.env.railway` |
| `STRATEGY` | No | `starter` | See `.env.railway` |
| `NETWORK` | No | `testnet` | |
| `DRY_RUN` | No | `true` | |
| Strategy knobs | No | see `.env.railway` | All six builder strategies included |

### Market symbol env names

| `STRATEGY` | Symbol variable |
|------------|-----------------|
| `starter` | `SYMBOL` |
| `market-making` | `MM_SYMBOL` |
| `grid` | `GRID_SYMBOL` |
| `momentum` | `MOM_SYMBOL` |
| `mean-reversion` | `MR_SYMBOL` |
| `twap` | `TWAP_SYMBOL` |

Railway injects variables into the process; strategies read them via `@dreamdex-bot-kit/core` env loading (no `.env` file required in the container).

Optional overrides: `RPC_URL`, `REST_API_URL`, `WS_URL`, `OWNER_ADDRESS` (session-key mode). See root [`.env.example`](../.env.example).

---

## Local parity (before Railway)

```bash
npm install
export PRIVATE_KEY=0x...   # funded testnet key or throwaway for dry-run reads
export NETWORK=testnet
export DRY_RUN=true
export STRATEGY=starter
npm run railway:start
```

Docker:

```bash
docker build -t dreamdex-bot .
docker run --rm -e PRIVATE_KEY=0x... -e STRATEGY=starter -e DRY_RUN=true dreamdex-bot
```

---

## dreamBot Builder handoff (separate repo)

**Recommended Deploy UX (step 5):**

1. User picks strategy / network / knobs in the builder UI (as today).
2. Builder acts as an **`.env` builder**: generate a Railway-ready env block from those settings (`STRATEGY`, `NETWORK`, `DRY_RUN`, symbol + strategy-prefixed knobs). **Omit `PRIVATE_KEY`.**
3. Show **Copy env for Railway** (and optionally open the template URL).
4. User pastes that block into Railway **Variables → RAW Editor**, then sets **only `PRIVATE_KEY`** and deploys.

Template defaults (`.env.railway`) cover the “I skipped the builder” path. Builder-generated env overrides those when pasted. **Never** put `PRIVATE_KEY` in DreamDEX URLs or store it server-side.

---

## Safety defaults

- Template defaults: **testnet** + **dry-run** (same as the builder).
- Go live only by explicitly setting `NETWORK=mainnet` and `DRY_RUN=false`.
- Read [DISCLAIMER](../DISCLAIMER.md) before trading with real funds.
