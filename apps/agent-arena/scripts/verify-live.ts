// End-to-end live verification for the pieces agent-arena can't prove with a
// typecheck: that the treasury can fund a fresh agent wallet, that the wallet
// can mint its own trading collateral from the faucet, that the venue has
// tradable markets, and — with --trade / --receipts — that a real IOC places
// and a reasoning receipt commits on-chain.
//
//   npm run verify:live -w agent-arena                 # provisioning + discovery only
//   npm run verify:live -w agent-arena -- --trade      # also place one tiny real IOC + claim
//   npm run verify:live -w agent-arena -- --receipts   # also deploy/commit a reasoning receipt
//   npm run verify:live -w agent-arena -- --trade --receipts --yes
//
// This sends REAL testnet transactions from your PRIVATE_KEY (the treasury),
// regardless of DRY_RUN — that is the point. Testnet only; it refuses to run
// against mainnet. Fund the treasury at https://testnet.somnia.network.

import { createInterface } from "node:readline/promises";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  activeMarkets,
  createExchange,
  isTradable,
  loadConfig,
  makeChain,
  marketOnchain,
  minLeftSec,
  outcomeSymbols,
  quantize,
  shutdown,
  snapshot,
  claimSettled,
  placeLimit,
} from "@dreamdex-bot-kit/ec-core";
import type { EcContext, UnifiedMarket, MarketOnchain } from "@dreamdex-bot-kit/ec-core";
import { generateWallet, createExchangeForKey, provisionAgentWallet } from "../server/agent-wallet.js";
import { commitReasoningNow } from "../server/reasoning-registry.js";

const flags = new Set(process.argv.slice(2));
const wantTrade = flags.has("--trade");
const wantReceipts = flags.has("--receipts");
const assumeYes = flags.has("--yes") || flags.has("-y") || process.env.VERIFY_CONFIRM === "yes";
if (flags.has("-h") || flags.has("--help")) {
  console.log("usage: npm run verify:live -w agent-arena -- [--trade] [--receipts] [--yes]");
  process.exit(0);
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
interface Result {
  name: string;
  status: Status;
  detail: string;
}
const results: Result[] = [];
function record(name: string, status: Status, detail = ""): void {
  results.push({ name, status, detail });
  const tag =
    status === "PASS" ? c.green("PASS") : status === "FAIL" ? c.red("FAIL") : status === "WARN" ? c.yellow("WARN") : c.dim("SKIP");
  console.log(`  [${tag}] ${name}${detail ? c.dim(" — " + detail) : ""}`);
}

async function confirm(question: string): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    console.log(c.yellow("non-interactive shell and --yes not passed — aborting before sending anything."));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

async function main(): Promise<number> {
  const cfg = loadConfig();

  console.log(c.bold("\nagent-arena — live verification\n"));
  console.log(`  network      ${cfg.network}`);
  console.log(`  rpc          ${cfg.rpcUrl}`);
  console.log(`  indexer      ${cfg.indexerUrl}`);
  console.log(`  collateral   ${cfg.addresses.collateral} (${cfg.decimals} decimals)`);
  console.log(`  dryRun       ${cfg.dryRun} ${c.dim("(ignored here — verify:live always sends real txns)")}`);
  console.log(`  steps        provisioning + market discovery${wantTrade ? " + live IOC + claim" : ""}${wantReceipts ? " + reasoning receipt" : ""}\n`);

  // ── 0. Guard rails ──────────────────────────────────────────────────────
  if (cfg.network === "mainnet") {
    record("network is testnet", "FAIL", "refusing to run against mainnet — set NETWORK=testnet");
    return 1;
  }
  if (!cfg.privateKey) {
    record("treasury key present", "FAIL", "PRIVATE_KEY is not set — fund one at testnet.somnia.network and put it in .env");
    return 1;
  }
  const treasury = privateKeyToAccount(cfg.privateKey).address;
  record("treasury key present", "PASS", treasury);

  const pub = createPublicClient({ chain: makeChain(cfg), transport: http(cfg.rpcUrl) });

  // ── 1. Treasury balance ────────────────────────────────────────────────
  const readCtx = createExchange({ withSigner: false });
  let treasuryOk = false;
  try {
    const bal = await pub.getBalance({ address: treasury });
    const drip = parseEther(process.env.AGENT_WALLET_GAS_STT ?? "2");
    const human = `${formatEther(bal)} native`;
    if (bal < drip) record("treasury has gas", "FAIL", `${human} — below one drip (${formatEther(drip)} STT); top it up at testnet.somnia.network`);
    else if (bal < drip * 3n) record("treasury has gas", "WARN", `${human} — enough for this run, low for repeated use`);
    else {
      record("treasury has gas", "PASS", human);
      treasuryOk = true;
    }
    treasuryOk = treasuryOk || bal >= drip;
  } catch (e) {
    record("treasury has gas", "FAIL", (e as Error).message);
  }

  if (!treasuryOk) {
    await shutdown(readCtx).catch(() => undefined);
    return summarize();
  }

  // ── 2. Confirm before the first real transaction ───────────────────────
  const proceed = await confirm(
    c.yellow(`\nAbout to send real testnet transactions from ${treasury}. Continue?`),
  );
  if (!proceed) {
    console.log("aborted — nothing sent.");
    await shutdown(readCtx).catch(() => undefined);
    return 1;
  }

  // ── 3. Provision a throwaway agent wallet (the exact engine path) ──────
  const w = generateWallet();
  console.log(c.dim(`\n  throwaway agent wallet: ${w.address}`));
  console.log(c.dim(`  (private key: ${w.privateKey} — testnet only; funds left on it are recoverable with this key or simply ignored)\n`));

  const prov = await provisionAgentWallet(w.privateKey, w.address);
  if (!prov.ok) {
    record("provisionAgentWallet (gas drip + faucet mint)", "FAIL", prov.error ?? "unknown error");
    await shutdown(readCtx).catch(() => undefined);
    return summarize();
  }
  record("provisionAgentWallet (gas drip + faucet mint)", "PASS", "engine's ensureFunded() path returned ok");

  // ── 4. Confirm the effects landed on-chain ────────────────────────────
  try {
    const nativeBal = await pub.getBalance({ address: w.address });
    record("gas drip landed", nativeBal > 0n ? "PASS" : "FAIL", `${formatEther(nativeBal)} native on the agent wallet`);
  } catch (e) {
    record("gas drip landed", "WARN", (e as Error).message);
  }
  const collateralAddr = cfg.addresses.collateral;
  if (!collateralAddr) {
    record("faucet collateral landed", "WARN", "no collateral address resolved in config");
  } else {
    try {
      const collRaw = await readCtx.exchange.client.getErc20Balance(collateralAddr, w.address);
      const collHuman = Number(collRaw) / 10 ** cfg.decimals;
      record("faucet collateral landed", collRaw > 0n ? "PASS" : "FAIL", `${collHuman} collateral on the agent wallet`);
    } catch (e) {
      record("faucet collateral landed", "WARN", `couldn't read balance: ${(e as Error).message}`);
    }
  }

  // ── 5. Market discovery ──────────────────────────────────────────────
  const watchlist = (process.env.WATCHLIST ?? "BTC,ETH").split(",").map((s) => s.trim()).filter(Boolean);
  const tradable: { market: UnifiedMarket; marketId: `0x${string}`; onchain: MarketOnchain; ttl: number; bestYesAsk?: number; yesMid?: number }[] = [];
  try {
    const markets = await activeMarkets(readCtx, { max: 25 });
    const scoped = markets.filter(
      (m) =>
        m.info.marketType === "BINARY" &&
        (watchlist.length === 0 || watchlist.some((a) => m.symbol.toUpperCase().includes(a.toUpperCase()))),
    );
    for (const market of scoped) {
      if (market.info.marketType !== "BINARY") continue;
      const onchain = await marketOnchain(readCtx, market);
      if (!onchain || !isTradable(onchain)) continue;
      // Same headroom gate the engine's market-loop applies: near expiry the
      // venue reports Trading but reverts new orders.
      const intervalSec = Number(market.info.intervalSec ?? 0);
      const ttl = Number(onchain.expiry) - Date.now() / 1000;
      if (ttl < minLeftSec(intervalSec || undefined)) continue;
      const { yes } = outcomeSymbols(market);
      const ob = await snapshot(readCtx, yes, 5).catch(() => ({}) as { bestYesAsk?: number; yesMid?: number });
      tradable.push({ market, marketId: market.info.marketId as `0x${string}`, onchain, ttl, bestYesAsk: ob.bestYesAsk, yesMid: ob.yesMid });
      console.log(
        c.dim(
          `    ${market.symbol.padEnd(26)} ${String(Math.round(ttl) + "s to expiry").padStart(14)}  mid ${ob.yesMid?.toFixed(3) ?? "  -  "}  ask ${ob.bestYesAsk?.toFixed(3) ?? "  -  "}`,
        ),
      );
    }
    // Trade the market with the MOST runway, not whichever came back first.
    tradable.sort((a, b) => b.ttl - a.ttl);
    if (tradable.length === 0) {
      record("tradable markets in scope", wantTrade ? "FAIL" : "WARN", `0 tradable markets matching [${watchlist.join(",")}] with enough expiry headroom right now`);
    } else {
      record("tradable markets in scope", "PASS", `${tradable.length} tradable (${tradable.map((t) => t.market.symbol).join(", ")})`);
    }
  } catch (e) {
    record("tradable markets in scope", "FAIL", (e as Error).message);
  }

  // ── 6. Optional: one real IOC + a claim sweep ────────────────────────
  let tradeCtx: EcContext | undefined;
  if (wantTrade) {
    const pick = tradable.find((t) => t.bestYesAsk !== undefined && t.bestYesAsk > 0 && t.bestYesAsk < 1);
    if (!pick) {
      record("live IOC places", "SKIP", "no market with a YES ask to cross this cycle — retry in a minute");
      record("claimSettled runs", "SKIP", "");
    } else {
      tradeCtx = createExchangeForKey(w.privateKey);
      const sizeUsd = Number(process.env.VERIFY_TRADE_USD ?? 1);
      const price = pick.bestYesAsk!;
      const size = quantize(tradeCtx, sizeUsd / price);
      console.log(c.dim(`    picking ${pick.market.symbol} (${Math.round(pick.ttl)}s to expiry), buying YES ${size} @ ${price.toFixed(3)}`));
      try {
        const placed = await placeLimit(tradeCtx, {
          market: pick.market,
          onchain: pick.onchain,
          outcome: "YES",
          side: "buy",
          price,
          size,
          type: "ioc",
        });
        if (placed.filled > 0) {
          record("live IOC places", "PASS", `filled ${placed.filled} @ ${placed.price.toFixed(3)} on ${pick.market.symbol} (tx ${placed.hash ?? "?"})`);
        } else if (placed.hash) {
          record("live IOC places", "WARN", `order sent (tx ${placed.hash}) but nothing crossed — SDK write path still verified`);
        } else {
          record("live IOC places", "WARN", `request rounded below one lot (size ${size}) — raise VERIFY_TRADE_USD`);
        }
      } catch (e) {
        record("live IOC places", "FAIL", (e as Error).message);
      }
      try {
        await claimSettled(tradeCtx, { scan: 25 });
        record("claimSettled runs", "PASS", "swept without error (nothing to claim yet is expected)");
      } catch (e) {
        record("claimSettled runs", "FAIL", (e as Error).message);
      }
    }
  } else {
    record("live IOC places", "SKIP", "pass --trade to place one");
    record("claimSettled runs", "SKIP", "pass --trade to run");
  }

  // ── 7. Optional: on-chain reasoning receipt ──────────────────────────
  if (wantReceipts) {
    const marketId = tradable[0]?.marketId ?? (`0x${"11".repeat(32)}` as `0x${string}`);
    process.env.REASONING_RECEIPTS_ENABLED = "true";
    try {
      const res = await commitReasoningNow({
        agentId: `verify-${Date.now()}`,
        marketId,
        cycleId: `verify-cycle-${Date.now()}`,
        reasoning: "verify:live synthetic decision — confirms the ReasoningRegistry deploy + commit path.",
        fairUpProbability: 0.5,
        confidence: 0.5,
        action: "BUY_UP",
        ts: new Date().toISOString(),
      });
      record("reasoning receipt commits", "PASS", `tx ${res.txHash} · registry ${res.registryAddress}`);
      if (!process.env.REASONING_REGISTRY_ADDRESS) {
        console.log(c.dim(`    set REASONING_REGISTRY_ADDRESS=${res.registryAddress} in .env to reuse this registry`));
      }
    } catch (e) {
      record("reasoning receipt commits", "FAIL", (e as Error).message);
    }
  } else {
    record("reasoning receipt commits", "SKIP", "pass --receipts to deploy + commit one");
  }

  if (tradeCtx) await shutdown(tradeCtx).catch(() => undefined);
  await shutdown(readCtx).catch(() => undefined);
  return summarize();
}

function summarize(): number {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(c.bold(`\nsummary: ${c.green(pass + " pass")} · ${fail ? c.red(fail + " fail") : "0 fail"} · ${warn ? c.yellow(warn + " warn") : "0 warn"} · ${skip} skip\n`));
  if (fail === 0) {
    console.log(c.green("✓ the live path this run exercised works end to end.\n"));
    return 0;
  }
  console.log(c.red("✗ at least one step failed — see above.\n"));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(c.red("\nunhandled error:"), e);
    process.exit(1);
  });
