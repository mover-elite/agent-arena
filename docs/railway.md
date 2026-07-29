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
4. In the template **Variables** tab:
   - **`PRIVATE_KEY`** — mark **required**, leave default empty (user fills at deploy).
   - **`STRATEGY`** — default `starter`.
   - **`NETWORK`** — default `testnet`.
   - **`DRY_RUN`** — default `true`.
   - Optional strategy knobs — same names as each strategy’s `.env.example` (see below).
5. **Do not** enable public networking for this service.
6. Create template, copy the share URL (e.g. `https://railway.com/template/<slug>`).
7. Paste that URL into `docs/railway.md` under **Template URL** once live.
8. Optional: [publish to the marketplace](https://docs.railway.com/templates/publish-and-share).

### Template URL

<!-- Replace after the template is created in Railway -->
_TBD — add the Railway template deploy link here._

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

| Variable | Required | Default | Notes |
|----------|----------|---------|--------|
| `PRIVATE_KEY` | Yes | — | Dedicated bot wallet recommended |
| `STRATEGY` | No | `starter` | `starter`, `market-making`, `grid`, `momentum`, `mean-reversion`, `twap` |
| `NETWORK` | No | `testnet` | `testnet` or `mainnet` |
| `DRY_RUN` | No | `true` | `true` / `false` |
| Strategy knobs | No | code defaults | Same keys as `strategies/<name>/.env.example` |

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

The builder should add a **Deploy on Railway** button on step 5 that opens the template URL. Pass **non-secret** variables as Railway service defaults (or documented copy-paste list): `STRATEGY`, `NETWORK`, `DRY_RUN`, symbol, and strategy-prefixed knobs. **Never** put `PRIVATE_KEY` in URL query parameters from the DreamDEX site.

---

## Safety defaults

- Template defaults: **testnet** + **dry-run** (same as the builder).
- Go live only by explicitly setting `NETWORK=mainnet` and `DRY_RUN=false`.
- Read [DISCLAIMER](../DISCLAIMER.md) before trading with real funds.
