/**
 * Railway worker entrypoint: pick STRATEGY, validate PRIVATE_KEY, run npm start for that workspace.
 */

import { spawn } from "node:child_process";

const ALLOWED = new Set([
  "starter",
  "market-making",
  "grid",
  "momentum",
  "mean-reversion",
  "twap",
]);

function normalizePrivateKey(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    console.log("[railway-start] Added 0x prefix to PRIVATE_KEY (MetaMask-style export).");
    return `0x${trimmed}`;
  }
  throw new Error("PRIVATE_KEY must be a hex string (with or without 0x prefix).");
}

function main() {
  const strategy = (process.env.STRATEGY ?? "starter").trim();
  if (!ALLOWED.has(strategy)) {
    console.error(
      `[railway-start] Unknown STRATEGY="${strategy}". Allowed: ${[...ALLOWED].join(", ")}`,
    );
    process.exit(1);
  }

  const keyRaw = process.env.PRIVATE_KEY;
  if (!keyRaw?.trim()) {
    console.error("[railway-start] Set PRIVATE_KEY in Railway service variables (never commit it).");
    process.exit(1);
  }

  let privateKey;
  try {
    privateKey = normalizePrivateKey(keyRaw);
  } catch (err) {
    console.error(`[railway-start] ${err.message}`);
    process.exit(1);
  }

  process.env.PRIVATE_KEY = privateKey;

  const network = process.env.NETWORK ?? "testnet";
  const dryRun = process.env.DRY_RUN ?? "true";
  console.log(
    `[railway-start] strategy=${strategy} network=${network} dryRun=${dryRun} wallet=derived-from-key`,
  );

  const child = spawn("npm", ["run", "start", "-w", strategy], {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });

  child.on("error", (err) => {
    console.error(`[railway-start] Failed to spawn npm: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[railway-start] npm exited on signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

main();
