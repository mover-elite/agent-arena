// Per-agent testnet wallets. Every agent gets its own dedicated EOA at
// creation — generated here, encrypted at rest (agents-store.ts, same
// crypto-secrets.ts helper used for user API keys). Going live no longer
// means sharing one platform wallet: it means this ONE agent's own wallet
// gets a small native-gas drip from the treasury (the platform's PRIVATE_KEY,
// repurposed from "the trading wallet" to "the funding source"), then mints
// its own trading collateral via the SDK's testnet faucet
// (`trader.faucet()` — real, verified against the SDK's own type
// definitions, not assumed). No shared wallet, no cross-agent order netting,
// no self-match risk between agents — each one trades and settles as its
// own on-chain identity.

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createWalletClient, createPublicClient, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, makeChain, shutdown, type EcContext } from "@dreamdex-bot-kit/ec-core";

const log = (s: string) => console.log(`${new Date().toISOString()} [wallet] ${s}`);

export function generateWallet(): { address: `0x${string}`; privateKey: Hex } {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  return { address, privateKey };
}

/** Builds an EcContext for an explicit private key — createExchange() only
 *  ever reads PRIVATE_KEY from env, which is fine for the platform's own
 *  seeded agents but not for N per-agent wallets. Mirrors createExchange's
 *  own construction (read from ec-core/src/exchange.ts) with the key injected. */
export function createExchangeForKey(privateKey: Hex): EcContext {
  const config = loadConfig();
  const exchange = new SomniaMarkets({
    indexerUrl: config.indexerUrl,
    chain: makeChain(config),
    wsRpcUrl: config.wsRpcUrl,
    addresses: config.addresses,
    priceFeed: config.priceFeed,
    privateKey,
  });
  return { exchange, config: { ...config, privateKey }, canTrade: true };
}

function treasuryWalletClient() {
  const config = loadConfig();
  if (!config.privateKey) throw new Error("PRIVATE_KEY (the treasury/funding source) is not set.");
  const chain = makeChain(config);
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
  return { wallet: createWalletClient({ account, chain, transport }), publicClient: createPublicClient({ chain, transport }) };
}

// The SDK's write path (faucet / placeLimit / claim) signs with a FIXED fee
// ceiling — 10M gas × DEFAULT_FEES.maxFeePerGas (60 gwei) — so the node
// reserves ~0.6 native per write up front, even though real gas is a tiny
// fraction of that (testnet gas price is ~6 gwei). A drip below that reserve
// gets the tx rejected pre-execution with a misleading "Missing or invalid
// parameters". Keep this comfortably above 0.6; don't "optimize" it down
// without also lowering the SDK's `gas`/`fees` in createExchangeForKey.
const GAS_DRIP = process.env.AGENT_WALLET_GAS_STT ?? "2";

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

/** Idempotent-in-spirit: safe to call again on an already-funded wallet (the
 *  caller checks wallet_funded_at first — see ensureLive in agents-store.ts). */
export async function provisionAgentWallet(agentPrivateKey: Hex, agentAddress: `0x${string}`): Promise<ProvisionResult> {
  try {
    const { wallet, publicClient } = treasuryWalletClient();
    const treasuryBalance = await publicClient.getBalance({ address: wallet.account!.address });
    const dripWei = parseEther(GAS_DRIP);
    if (treasuryBalance < dripWei) {
      return {
        ok: false,
        error: `treasury wallet ${wallet.account!.address} holds too little native token (${treasuryBalance} wei) to fund a new agent — top it up at testnet.somnia.network`,
      };
    }

    const dripHash = await wallet.sendTransaction({ to: agentAddress, value: dripWei, account: wallet.account!, chain: wallet.chain });
    await publicClient.waitForTransactionReceipt({ hash: dripHash });
    log(`funded ${agentAddress} with ${GAS_DRIP} native token (tx ${dripHash})`);

    const agentCtx = createExchangeForKey(agentPrivateKey);
    try {
      const res = await agentCtx.exchange.trader.faucet();
      log(`faucet minted test collateral to ${agentAddress} (tx ${res.hash ?? "?"})`);
    } finally {
      // This ctx is only for the one faucet write — trading uses a separate
      // cached ctx (getAgentExchange). Close it so its live-tail socket
      // doesn't leak once per provisioned agent.
      await shutdown(agentCtx).catch(() => undefined);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// One EcContext per agent wallet, reused across cycles rather than rebuilt
// (each holds a live-tail connection) — see shutdownAgentContext if an agent
// is ever deleted, which this app doesn't support yet.
const contextCache = new Map<string, EcContext>();

export function getAgentExchange(agentId: string, privateKey: Hex): EcContext {
  let ctx = contextCache.get(agentId);
  if (!ctx) {
    ctx = createExchangeForKey(privateKey);
    contextCache.set(agentId, ctx);
  }
  return ctx;
}
