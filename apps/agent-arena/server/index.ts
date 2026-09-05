// Agent Arena — shared market loop that drives every registered agent's LLM
// decision each cycle and executes for real against that agent's own
// testnet wallet, and reconciles settlements; plus the HTTP API + static UI,
// in the same process (the "app" is one thing: a market-loop worker and a
// web server sharing one SQLite store and one JSONL log directory).
// Run with: npm run dev -w agent-arena

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createExchange } from "@dreamdex-bot-kit/ec-core";
import { buildMarketSnapshots } from "./market-loop.js";
import { runAgentCycle } from "./agent-engine.js";
import { reconcileSettlements } from "./settlement-reconciler.js";
import { loadRiskConfig } from "./risk.js";
import { createAgent, listAgents } from "./agents-store.js";
import { agentsRouter } from "./api/agents.js";
import { authRouter } from "./api/auth.js";
import { dashboardRouter } from "./api/dashboard.js";
import { getPreset } from "./strategy-presets.js";
import { markCycleStart, publishSnapshots, refreshUnderlying } from "./market-state.js";

const log = (s: string) => console.log(`${new Date().toISOString()} [arena] ${s}`);
const __dirname = dirname(fileURLToPath(import.meta.url));

// The agent-decision cadence. Kept slow on purpose — the dashboard stays live
// off the 5s price-feed loop, so this only needs to be as fast as you want
// agents to *re-reason*. LLM spend scales with this; see llm-budget.ts.
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS ?? 60_000);
const WATCHLIST = (process.env.WATCHLIST ?? "BTC,ETH")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sleep = async (ms: number, stopped: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};

function seedDefaultAgentsIfEmpty(): void {
  // Opt-in: the flagships reason with the shared .env key and fund a real
  // wallet from the treasury, so an unattended process should not conjure
  // them. Set SEED_FLAGSHIP_AGENTS=true to get leaderboard activity before
  // anyone signs in.
  if (process.env.SEED_FLAGSHIP_AGENTS !== "true") return;
  if (listAgents().length > 0) return;
  // Two platform-owned flagships (ownerUserId null) — reason with the shared
  // .env key, not any user's, so the leaderboard has activity before anyone
  // signs in. Their prompts come from the strategy-preset gallery so there's
  // one source of truth; wallets fund lazily once the treasury has balance.
  const flagships: [string, string][] = [
    ["Momentum Max", "momentum"],
    ["Fade the Crowd", "fade"],
  ];
  for (const [name, presetId] of flagships) {
    const preset = getPreset(presetId);
    if (preset) createAgent(name, preset.prompt, null);
  }
  log(`seeded ${flagships.length} platform-owned flagship agents`);
}

function startServer(): void {
  const app = express();
  app.use(express.json());
  app.use("/api", agentsRouter);
  app.use("/api", authRouter);
  app.use("/api", dashboardRouter);
  // A live dashboard should never be served stale — revalidate HTML/JS every load.
  app.use(
    express.static(join(__dirname, "..", "public"), {
      setHeaders: (res, p) => {
        if (p.endsWith(".html") || p.endsWith(".js")) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => log(`http server on :${port}`));
}

// One read-only exchange, shared by the (slow) agent-decision loop and the
// (fast) price-feed loop. No signer here — each agent trades through its OWN
// signed context (agent-wallet.ts).
const readCtx = createExchange({ withSigner: false });
const ASSETS = WATCHLIST.length ? WATCHLIST : ["BTC", "ETH"];
const PRICE_FEED_INTERVAL_MS = Number(process.env.PRICE_FEED_INTERVAL_MS ?? 5_000);

let stop = false;
process.on("SIGINT", () => (stop = true));
process.on("SIGTERM", () => (stop = true));

async function runMarketLoop(): Promise<void> {
  const cfg = loadRiskConfig();
  log(`market loop up · dryRun=${readCtx.config.dryRun} · watchlist=[${ASSETS.join(",")}] · interval=${CYCLE_INTERVAL_MS}ms`);

  while (!stop) {
    try {
      markCycleStart();
      const snapshots = await buildMarketSnapshots(readCtx, WATCHLIST);
      publishSnapshots(snapshots);
      if (snapshots.length === 0) {
        log("no tradable markets in scope this cycle");
      } else {
        for (const agent of listAgents()) {
          try {
            await runAgentCycle(agent, snapshots, cfg);
          } catch (e) {
            log(`agent ${agent.name} cycle error: ${(e as Error).message}`);
          }
        }
      }
      await reconcileSettlements(readCtx);
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;
    await sleep(CYCLE_INTERVAL_MS, () => stop);
  }
  log("market loop stopped");
}

// Underlying BTC/ETH spot is decoupled from the agent cadence: it's just cheap
// price-feed reads, so poll it every few seconds to keep the dashboard chart
// ticking in real time instead of once per (slow, LLM-bound) decision cycle.
async function runPriceFeedLoop(): Promise<void> {
  await refreshUnderlying(readCtx.exchange, ASSETS).catch(() => undefined);
  log(`price feed up · assets=[${ASSETS.join(",")}] · every ${PRICE_FEED_INTERVAL_MS}ms`);
  while (!stop) {
    await sleep(PRICE_FEED_INTERVAL_MS, () => stop);
    if (stop) break;
    await refreshUnderlying(readCtx.exchange, ASSETS).catch((e) => log(`price feed error: ${(e as Error).message}`));
  }
}

seedDefaultAgentsIfEmpty();
startServer();
runPriceFeedLoop().catch((e) => log(`price feed loop died: ${(e as Error).message}`));
runMarketLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});
