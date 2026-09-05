export type AgentMode = "paper" | "live";
export type LlmProviderName = "anthropic" | "gemini";

/** How an agent decides each cycle.
 *  - `"llm"`: send the strategy prompt + live data to an LLM every cycle (the original).
 *  - `"code"`: an LLM wrote a pure `decide()` function once at creation; the runtime
 *    executes it in a sandbox each cycle — zero per-cycle LLM cost. */
export type StrategyKind = "llm" | "code";

export interface Agent {
  id: string;
  name: string;
  /** For `"llm"` agents: the strategy/personality prompt. For `"code"` agents: the
   *  natural-language description the decision code was generated from. */
  strategyPrompt: string;
  mode: AgentMode;
  virtualBalanceUsd: number;
  createdAt: string;
  /** null = platform-owned (the seeded flagship agents, using the shared .env key). */
  ownerUserId: string | null;
  /** Every agent gets its own dedicated testnet wallet at creation (public address only — the
   *  private key is encrypted at rest and never leaves agents-store.ts/agent-wallet.ts). */
  walletAddress: `0x${string}`;
  /** This agent has its OWN LLM key (encrypted at rest, never returned by any API — only this
   *  boolean and the provider below are). Every user-owned agent needs one; there is no
   *  account-level fallback. The seeded flagships (no owner) use the platform `.env` key. */
  hasOwnLlmKey: boolean;
  /** The provider of this agent's own key, or null if it has none. Not a secret. */
  ownLlmProvider: LlmProviderName | null;
  strategyKind: StrategyKind;
  /** `"code"` agents only. The generated `decide()` source (shown to the owner, not a secret). */
  generatedCode: string | null;
  /** `"code"` agents only. The current tunable knobs the code runs with. */
  generatedParams: Record<string, number | boolean> | null;
  /** `"code"` agents only. Explanation + param schema + provenance for the UI. */
  generatedSpec: GeneratedStrategySpec | null;
  /** Last sandbox/generation failure, human-readable. null when healthy. */
  codeError: string | null;
  /** ISO timestamp the code was (re)generated; null while it still needs generating. */
  codeGeneratedAt: string | null;
  /** ISO timestamp the owner paused this agent; null = running. Paused agents skip
   *  their decision cycle entirely (no reasoning, no trades) but keep their
   *  positions and history, and their open positions still settle. */
  pausedAt: string | null;
}

/** One tunable knob on a generated strategy, and how the UI should render it. */
export interface GeneratedParamField {
  key: string;
  label: string;
  type: "number" | "boolean";
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

/** Everything about a generated strategy except the code itself and the live params. */
export interface GeneratedStrategySpec {
  explanation: string;
  blurb: string;
  paramSchema: GeneratedParamField[];
  sourceDescription: string;
  /** `"preset"` when the code came from a hand-authored `strategy-code-presets.ts`
   *  entry rather than an LLM generation call. */
  provider: LlmProviderName | "preset";
  model: string | null;
  /** Set when `provider === "preset"` — which built-in strategy this is. */
  presetId?: string;
}

/** The plain-object view of a market handed to a generated `decide(market, params, lib)`.
 *  Richer than what the LLM path sees — includes the real underlying candles + strike. */
export interface CodeMarketView {
  marketId: string;
  symbol: string;
  asset: string;
  question: string;
  intervalSec: number;
  secondsToExpiry: number;
  tradingStart: number;
  expiresAt: number;
  yesMid: number | null;
  bestYesBid: number | null;
  bestYesAsk: number | null;
  spread: number | null;
  /** yesMid samples, oldest first, ≤20 (from the cycle snapshot). */
  recentHistory: number[];
  /** yesMid samples, oldest first, ≤360 (process-wide rolling history). */
  history: number[];
  /** Underlying price at `tradingStart` — the level "Up" is measured against. null if unknown. */
  strike: number | null;
  underlying: {
    price: number;
    ema: number;
    change24hPct: number | null;
    high24h: number | null;
    low24h: number | null;
    /** 1-minute OHLCV, oldest first: [tsMs, open, high, low, close, volume]. */
    candles: [number, number, number, number, number, number][];
  } | null;
}

/** What a generated `decide()` returns for one market, or null to abstain. */
export interface CodeDecision {
  fairUpProbability: number;
  confidence: number;
  reasoning: string;
}

/** How an agent's reasoning credentials resolved — UI transparency, no secret. */
export interface LlmCredentialsMeta {
  provider: LlmProviderName | null;
  source: "agent" | "platform" | "none";
}

export interface User {
  id: string;
  address: `0x${string}`;
  displayName: string | null;
  llmProvider: LlmProviderName | null;
  anthropicModel: string | null;
  geminiModel: string | null;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  createdAt: string;
}

export interface LlmCredentials {
  provider: LlmProviderName;
  apiKey: string;
  model?: string;
}

export interface MarketPricePoint {
  ts: number;
  yesMid: number;
}

export interface MarketSnapshot {
  marketId: `0x${string}`;
  symbol: string;
  asset: string;
  intervalSec: number;
  /** Unix seconds the trading window opened — the strike is the underlying's price at this instant. */
  tradingStart: number;
  /** The human question, e.g. "BTC closes at or above its opening price". */
  question: string;
  expiresAt: number; // unix seconds
  secondsToExpiry: number;
  bestYesBid?: number;
  bestYesAsk?: number;
  yesMid?: number;
  /** Recent yesMid samples, oldest first, this process's own rolling history — the SDK exposes no candle feed for event contracts. */
  recentHistory: MarketPricePoint[];
}

export type DecisionAction = "BUY_UP" | "BUY_DOWN" | "HOLD" | "SKIP_RISK_GATED";

export interface LlmMarketCall {
  marketId: string;
  fairUpProbability: number;
  confidence: number;
  reasoning: string;
}

export interface DecisionRecord {
  type: "decision";
  ts: string;
  cycleId: string;
  agentId: string;
  marketId: string;
  marketSymbol: string;
  expiresAt: string;
  marketImpliedUpProbability: number | null;
  llmFairUpProbability: number | null;
  confidence: number | null;
  edge: number | null;
  reasoning: string;
  action: DecisionAction;
  skipReason: string | null;
  sizeShares: number | null;
  limitPrice: number | null;
  orderId: string | null;
  txHash: string | null;
  mode: AgentMode;
}

export interface ClaimRecord {
  type: "claim";
  ts: string;
  agentId: string;
  marketId: string;
  amountClaimed: number;
  txHash: string | null;
}

export interface SettlementRecord {
  type: "settlement";
  ts: string;
  agentId: string;
  marketId: string;
  outcome: "Up" | "Down" | "Void";
  realizedPnlUsd: number;
  referencedDecisionCycleIds: string[];
  llmBrierComponent: number | null;
}

/** Written by reasoning-registry.ts once an on-chain reasoning-receipt commit
 *  confirms, so the JSONL log (and the UI feed built from it) can show a
 *  decision's reasoning as provably-committed rather than only console-logged.
 *  Matched back to its decision row on (marketId, decisionCycleId). */
export interface ReceiptRecord {
  type: "receipt";
  ts: string;
  agentId: string;
  marketId: string;
  decisionCycleId: string;
  decisionTs: string;
  decisionHash: `0x${string}`;
  txHash: `0x${string}`;
  registryAddress: `0x${string}`;
}

export type LogRecord = DecisionRecord | ClaimRecord | SettlementRecord | ReceiptRecord;

export interface RiskConfig {
  maxPositionPerMarketUsd: number;
  maxCycleNotionalUsd: number;
  dailyLossCapUsd: number;
  minConfidence: number;
  minEdge: number;
  tradeCooldownMs: number;
}
