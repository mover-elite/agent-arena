// Differentiator §6d: on-chain reasoning receipts. Off by default
// (REASONING_RECEIPTS_ENABLED=false) since it needs a funded wallet and a
// deployed contract this project hasn't tested live yet — see the plan's
// cut-line notes. When enabled, every actionable decision (paper or live)
// gets its reasoning hash committed via the platform's shared wallet, acting
// here as a relayer rather than a trader — this never touches trading funds.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, makeChain } from "@dreamdex-bot-kit/ec-core";
import { appendRecord } from "./decision-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const log = (s: string) => console.log(`${new Date().toISOString()} [reasoning-registry] ${s}`);

export function receiptsEnabled(): boolean {
  return (process.env.REASONING_RECEIPTS_ENABLED ?? "false") === "true";
}

function compile(): { abi: Abi; bytecode: `0x${string}` } {
  const solc = require("solc");
  const file = "ReasoningRegistry.sol";
  const source = readFileSync(path.resolve(__dirname, "..", "contracts", file), "utf8");
  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error("solc errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts[file]!["ReasoningRegistry"];
  return { abi: c.abi as Abi, bytecode: ("0x" + c.evm.bytecode.object) as `0x${string}` };
}

interface RegistryHandle {
  wallet: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  address: `0x${string}`;
  abi: Abi;
}

let handle: RegistryHandle | undefined;

async function getHandle(): Promise<RegistryHandle> {
  if (handle) return handle;
  const cfg = loadConfig();
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required to commit reasoning receipts.");
  const chain = makeChain(cfg);
  const account = privateKeyToAccount(cfg.privateKey);
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const { abi, bytecode } = compile();
  const configured = (process.env.REASONING_REGISTRY_ADDRESS ?? "").trim();
  let address = configured as `0x${string}` | "";
  if (!address) {
    const deployHash = await wallet.deployContract({ abi, bytecode, args: [], account, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
    address = receipt.contractAddress;
    log(`deployed ReasoningRegistry at ${address} — set REASONING_REGISTRY_ADDRESS to reuse it next run`);
  }

  handle = { wallet, publicClient, address, abi };
  return handle;
}

export interface CommittedDecision {
  agentId: string;
  marketId: `0x${string}`;
  cycleId: string;
  reasoning: string;
  fairUpProbability: number;
  confidence: number;
  action: string;
  ts: string;
}

export function hashDecision(d: CommittedDecision): `0x${string}` {
  return keccak256(toHex(JSON.stringify(d)));
}

export interface CommitResult {
  txHash: `0x${string}`;
  decisionHash: `0x${string}`;
  registryAddress: `0x${string}`;
}

/** Awaited commit — deploys the registry on first use (unless
 *  REASONING_REGISTRY_ADDRESS is set), writes the hash on-chain, and appends a
 *  `receipt` record to the agent's JSONL log so the UI feed can mark that
 *  decision's reasoning as provably committed. Throws on any failure. */
export async function commitReasoningNow(d: CommittedDecision): Promise<CommitResult> {
  const decisionHash = hashDecision(d);
  const agentIdHash = keccak256(toHex(d.agentId));
  // marketId is emitted as an opaque indexed bytes32 topic — hash it so the
  // arg is always exactly 32 bytes regardless of the venue's id width.
  const marketIdHash = keccak256(toHex(d.marketId));
  const { wallet, address, abi } = await getHandle();
  const txHash = await wallet.writeContract({
    address,
    abi,
    functionName: "commitReasoning",
    args: [agentIdHash, marketIdHash, decisionHash],
    account: wallet.account!,
    chain: wallet.chain,
  });
  appendRecord({
    type: "receipt",
    ts: new Date().toISOString(),
    agentId: d.agentId,
    marketId: d.marketId,
    decisionCycleId: d.cycleId,
    decisionTs: d.ts,
    decisionHash,
    txHash,
    registryAddress: address,
  });
  log(`committed ${d.agentId.slice(0, 8)} ${d.marketId.slice(0, 10)} -> ${txHash}`);
  return { txHash, decisionHash, registryAddress: address };
}

/** Fire-and-forget wrapper for the trading loop: never awaited, never throws. */
export function commitReasoningAsync(d: CommittedDecision): void {
  if (!receiptsEnabled()) return;
  commitReasoningNow(d).catch((e) => log(`commit failed: ${(e as Error).message}`));
}
