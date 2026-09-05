import { Router } from "express";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import {
  clearGeneratedCode,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentLlmCredentials,
  getDailyPnlUsd,
  getGeneratedStrategy,
  getLastTradeAtMs,
  isWalletFunded,
  listAgents,
  markCodeGenerated,
  setAgentLlmCredentials,
  setAgentPaused,
  setStrategyKind,
  setCodeError,
  setGeneratedStrategy,
  setStrategyPrompt,
  type AgentLlmKeyInput,
} from "../agents-store.js";
import { readAgentRecords } from "../decision-log.js";
import { computeAgentStats } from "../stats.js";
import { renderShareCard } from "../share-card.js";
import { computeDuel } from "../duel.js";
import { gateTrade, loadRiskConfig } from "../risk.js";
import { receiptsEnabled } from "../reasoning-registry.js";
import { budgetConfig, budgetSnapshot } from "../llm-budget.js";
import { fundAgent } from "../fund-agent.js";
import { currentProvider, resolveCredentialsMeta } from "../llm-decide.js";
import { attachUserIfPresent, requireAuth } from "../auth.js";
import { hit, peek } from "../rate-limit.js";
import { getUserById } from "../users-store.js";
import { STRATEGY_PRESETS, getPreset } from "../strategy-presets.js";
import {
  CODE_PRESETS,
  getCodePreset,
  paramsForCodePreset,
  specForCodePreset,
  validateCodePreset,
} from "../strategy-code-presets.js";
import { buildCodeMarketViews } from "../code-market-view.js";
import { runStrategyCode } from "../code-runner.js";
import { generateStrategy } from "../strategy-gen.js";
import { getLatestSnapshots } from "../market-state.js";
import type { Agent, GeneratedParamField } from "../types.js";

/** Pull an optional per-agent LLM key out of a request body. Returns
 *  `undefined` (no key given), an `AgentLlmKeyInput`, or an error string. */
function parseAgentLlmKey(body: Record<string, unknown>): AgentLlmKeyInput | undefined | { error: string } {
  const raw = body.llmApiKey;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.trim().length < 8) return { error: "llmApiKey must be a non-trivial string" };
  if (body.llmProvider !== "anthropic" && body.llmProvider !== "gemini") {
    return { error: "llmProvider must be 'anthropic' or 'gemini' when llmApiKey is set" };
  }
  const model = typeof body.llmModel === "string" ? body.llmModel : undefined;
  return { provider: body.llmProvider, apiKey: raw.trim(), model };
}

export const agentsRouter = Router();

// Public read API (differentiator §6a) — CORS open, no auth required for GET:
// other builders can embed a leaderboard or an agent's feed without touching
// our UI. Mutating endpoints below still require a signed-in session.
agentsRouter.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
agentsRouter.use(attachUserIfPresent);

function ownerLabel(agent: Agent): { ownerAddress: string | null; ownerDisplayName: string | null } {
  if (!agent.ownerUserId) return { ownerAddress: null, ownerDisplayName: null };
  const owner = getUserById(agent.ownerUserId);
  return { ownerAddress: owner?.address ?? null, ownerDisplayName: owner?.displayName ?? null };
}

/** The agent shape returned by the API: adds owner labels + derived flags, and
 *  hides `generatedCode` from everyone but the owner (it's the owner's code,
 *  not a public artifact). `isGenerating` mirrors the `isFunded`/"provisioning"
 *  pattern for the "writing its logic…" UI state. */
function agentPayload(agent: Agent, isOwner: boolean) {
  return {
    ...agent,
    ...ownerLabel(agent),
    isFunded: isWalletFunded(agent.id),
    llmKey: resolveCredentialsMeta(agent),
    llmBudget: budgetSnapshot(agent.id),
    isGenerating: agent.strategyKind === "code" && !agent.codeGeneratedAt && !agent.codeError,
    generatedCode: isOwner ? agent.generatedCode : null,
  };
}

/** Coerce a raw `params` body against a generated strategy's paramSchema.
 *  Returns the clean map or an error message. */
function coerceParams(
  raw: unknown,
  schema: GeneratedParamField[],
): { params: Record<string, number | boolean> } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "params must be an object" };
  const src = raw as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  for (const f of schema) {
    const v = f.key in src ? src[f.key] : f.default;
    if (f.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `${f.key} must be a number` };
      if (f.min !== undefined && v < f.min) return { error: `${f.key} must be ≥ ${f.min}` };
      if (f.max !== undefined && v > f.max) return { error: `${f.key} must be ≤ ${f.max}` };
      out[f.key] = v;
    } else {
      if (typeof v !== "boolean") return { error: `${f.key} must be true or false` };
      out[f.key] = v;
    }
  }
  return { params: out };
}

// Transparency: the exact knobs the engine is running with right now — so
// "the agent decided" is checkable against real, inspectable gates rather
// than taken on faith.
agentsRouter.get("/config", (_req, res) => {
  const ecCfg = loadConfig();
  const risk = loadRiskConfig();
  res.json({
    network: ecCfg.network,
    dryRun: ecCfg.dryRun,
    llmProvider: currentProvider(),
    cycleIntervalMs: Number(process.env.CYCLE_INTERVAL_MS ?? 60_000),
    watchlist: (process.env.WATCHLIST ?? "BTC,ETH").split(",").map((s) => s.trim()).filter(Boolean),
    risk,
    maxAgentFundsPerHour: Number(process.env.MAX_AGENT_FUNDS_PER_HOUR ?? 20),
    reasoningReceiptsEnabled: receiptsEnabled(),
    llmBudget: {
      ...budgetConfig(),
      skipUnchangedThreshold: Number(process.env.SKIP_UNCHANGED_THRESHOLD ?? 0.02),
      forceReevaluateMs: Number(process.env.FORCE_REEVALUATE_MS ?? 15 * 60_000),
    },
  });
});

// Curated strategy gallery — a consumer picks one instead of writing a prompt
// from scratch. Public so other UIs can offer the same starting points.
agentsRouter.get("/strategy-presets", (_req, res) => {
  res.json({ presets: STRATEGY_PRESETS });
});

// Prebuilt CODED strategies (strategy-code-presets.ts) — pick one and get a
// coded agent with the decision function pre-loaded: no LLM key, no generation
// call. `code` is omitted here to keep the payload lean (the owner still sees it
// on their agent page); everything else the UI needs is included.
agentsRouter.get("/code-presets", (_req, res) => {
  res.json({ presets: CODE_PRESETS.map(({ code: _code, ...rest }) => rest) });
});

agentsRouter.get("/agents", (_req, res) => {
  const userId = res.locals.userId as string | undefined;
  const agents = listAgents().map((a) => ({
    ...agentPayload(a, Boolean(userId) && userId === a.ownerUserId),
    stats: computeAgentStats(a.id),
  }));
  agents.sort((a, b) => b.stats.pnlUsd - a.stats.pnlUsd);
  res.json({ agents });
});

// Abuse limits: each new agent provisions a wallet + drips gas from the shared
// treasury, so cap how many one account can hold and how fast it can spawn them.
const MAX_AGENTS_PER_USER = Number(process.env.MAX_AGENTS_PER_USER ?? 12);
const AGENT_CREATES_PER_HOUR = Number(process.env.AGENT_CREATES_PER_HOUR ?? 6);

agentsRouter.post("/agents", requireAuth, async (req, res) => {
  const { name, presetId } = req.body ?? {};
  const creatorId = res.locals.userId as string;

  const owned = listAgents().filter((a) => a.ownerUserId === creatorId).length;
  if (owned >= MAX_AGENTS_PER_USER) {
    return void res.status(429).json({ error: `agent limit reached (${MAX_AGENTS_PER_USER} per account) — delete one first` });
  }
  const rl = peek(`create:${creatorId}`, AGENT_CREATES_PER_HOUR, 3_600_000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    return void res.status(429).json({ error: `too many agents created this hour (max ${AGENT_CREATES_PER_HOUR}) — try again in ${Math.ceil(rl.retryAfterMs / 60000)}m` });
  }
  const noteCreated = () => hit(`create:${creatorId}`, AGENT_CREATES_PER_HOUR, 3_600_000);

  // ── Prebuilt coded preset ────────────────────────────────────────────────
  // Pre-load a hand-authored decide() from strategy-code-presets.ts: the agent
  // is `kind:"code"` but nothing is generated, so NO LLM key is required. A key
  // may still be passed (stored, enables a later /regenerate).
  const codePresetId: unknown = req.body?.codePresetId;
  if (typeof codePresetId === "string") {
    if (typeof presetId === "string") {
      return void res.status(400).json({ error: "pass either presetId or codePresetId, not both" });
    }
    const cp = getCodePreset(codePresetId);
    if (!cp) {
      return void res.status(400).json({ error: `unknown codePresetId "${codePresetId}" — see GET /api/code-presets` });
    }
    const rawPrompt = req.body?.strategyPrompt;
    const description =
      typeof rawPrompt === "string" && rawPrompt.trim().length > 0 ? rawPrompt.trim() : cp.description;
    if (description.length > 2000) return void res.status(400).json({ error: "strategyPrompt is too long (max 2000 chars)" });
    const codeName = typeof name === "string" && name.trim().length > 0 ? name.trim() : cp.name;
    if (codeName.length > 60) return void res.status(400).json({ error: "name is too long (max 60 chars)" });

    const key = parseAgentLlmKey(req.body ?? {});
    if (key && "error" in key) return void res.status(400).json({ error: key.error });

    // Static gate + a deterministic synthetic sandbox run (memoized per preset).
    // The first real cycle would also surface a fault via code_error, but a
    // corrupt deploy should fail loudly at create time.
    const health = await validateCodePreset(cp);
    if (!health.ok) {
      return void res.status(500).json({ error: `code preset "${cp.id}" failed its self-check: ${health.error}` });
    }

    const userId = res.locals.userId as string;
    const agent = createAgent(codeName, description, userId, {
      kind: "code",
      llm: key && !("error" in key) ? key : undefined,
    });
    setGeneratedStrategy(agent.id, { code: cp.code, params: paramsForCodePreset(cp), spec: specForCodePreset(cp) });
    markCodeGenerated(agent.id);
    noteCreated();
    return void res.status(201).json({ agent: agentPayload(getAgent(agent.id)!, true) });
  }

  const kind: "llm" | "code" = req.body?.kind === "code" ? "code" : "llm";

  // A preset just supplies a default name + the strategy prompt. It works for
  // either kind: an llm agent reasons from it, a coded agent generates its
  // decide() from it (on the first cycle).
  const preset = typeof presetId === "string" ? getPreset(presetId) : undefined;
  if (typeof presetId === "string" && !preset) {
    return void res.status(400).json({ error: `unknown presetId "${presetId}" — see GET /api/strategy-presets` });
  }
  const strategyPrompt: unknown = req.body?.strategyPrompt ?? preset?.prompt;
  const resolvedName: unknown = typeof name === "string" && name.trim().length > 0 ? name : preset?.name;

  if (typeof resolvedName !== "string" || resolvedName.trim().length === 0 || resolvedName.length > 60) {
    return void res.status(400).json({ error: "name is required (max 60 chars)" });
  }
  const promptLabel = kind === "code" ? "a description of how the agent should decide" : "strategyPrompt (or a valid presetId)";
  if (typeof strategyPrompt !== "string" || strategyPrompt.trim().length === 0 || strategyPrompt.length > 2000) {
    return void res.status(400).json({ error: `${promptLabel} is required (max 2000 chars)` });
  }
  const userId = res.locals.userId as string;

  // Every agent brings its OWN key — llm agents reason with it every cycle,
  // coded agents use it once to write their decision function.
  const perAgentKey = parseAgentLlmKey(req.body ?? {});
  if (perAgentKey && "error" in perAgentKey) return void res.status(400).json({ error: perAgentKey.error });
  if (!perAgentKey) {
    return void res.status(400).json({
      error:
        kind === "code"
          ? "llmProvider + llmApiKey are required — used once to generate this agent's decision code."
          : "llmProvider + llmApiKey are required — every agent reasons with its own key.",
    });
  }

  // Wallet funding (and, for coded agents, code generation) happen lazily on
  // the first eligible cycle (agent-engine.ts) — so creation stays instant.
  const agent = createAgent(resolvedName.trim(), strategyPrompt.trim(), userId, { llm: perAgentKey, kind });
  noteCreated();
  res.status(201).json({ agent: agentPayload(agent, true) });
});

// Owner-only. Two modes: rotate the LLM key (llmProvider+llmApiKey), or — for a
// coded agent — save edited params (validated in the sandbox before persisting).
agentsRouter.patch("/agents/:id", requireAuth, async (req, res) => {
  const agent = getAgent(req.params.id ?? "");
  if (!agent) return void res.status(404).json({ error: "not found" });
  const ownerUserId = agent.ownerUserId;
  if (!ownerUserId || ownerUserId !== (res.locals.userId as string)) {
    return void res.status(403).json({ error: "not your agent" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("paused" in body) {
    setAgentPaused(agent.id, body.paused === true);
    return void res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
  }

  // Switch reasoning mode. "llm" ⇄ "code" both keep the same strategyPrompt.
  //  → code: needs a key; generates decide() inline from the current prompt.
  //  → llm : drops the generated code; reasons from the prompt every cycle.
  if ("strategyKind" in body) {
    const next: "llm" | "code" = body.strategyKind === "code" ? "code" : "llm";
    if (next === agent.strategyKind) {
      return void res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
    }
    if (next === "llm") {
      setStrategyKind(agent.id, "llm");
      clearGeneratedCode(agent.id);
      return void res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
    }
    // → code
    const creds = getAgentLlmCredentials(agent.id);
    if (!creds) return void res.status(400).json({ error: "add an LLM key first (PATCH with llmProvider + llmApiKey) — generating the code needs one call" });
    const rl = hit(`regen:${agent.id}`, 1, Number(process.env.REGEN_COOLDOWN_MS ?? 45_000));
    if (!rl.ok) {
      res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      return void res.status(429).json({ error: `too fast — wait ${Math.ceil(rl.retryAfterMs / 1000)}s` });
    }
    setStrategyKind(agent.id, "code");
    clearGeneratedCode(agent.id);
    const r = await generateStrategy({ description: agent.strategyPrompt, name: agent.name, provider: creds.provider, apiKey: creds.apiKey, model: creds.model });
    if (!r.ok) {
      setCodeError(agent.id, r.error);
      return void res.status(422).json({ agent: agentPayload(getAgent(agent.id)!, true), error: r.error });
    }
    setGeneratedStrategy(agent.id, { code: r.code, params: r.params, spec: r.spec });
    markCodeGenerated(agent.id);
    return void res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
  }

  if ("params" in body) {
    if (agent.strategyKind !== "code") return void res.status(400).json({ error: "this agent is not a coded agent" });
    const gen = getGeneratedStrategy(agent.id);
    if (!gen) return void res.status(409).json({ error: "the agent's code hasn't been generated yet" });
    const coerced = coerceParams(body.params, gen.spec.paramSchema);
    if ("error" in coerced) return void res.status(400).json({ error: coerced.error });
    const check = await runStrategyCode(gen.code, coerced.params, buildCodeMarketViews(getLatestSnapshots()), { timeoutMs: 1000 });
    if (!check.ok) return void res.status(400).json({ error: `params rejected (${check.kind}): ${check.message}` });
    setGeneratedStrategy(agent.id, { params: coerced.params });
    const updated = getAgent(agent.id)!;
    return void res.json({ agent: agentPayload(updated, true) });
  }

  const parsed = parseAgentLlmKey(body);
  if (!parsed) return void res.status(400).json({ error: "pass llmProvider + llmApiKey to rotate the key, or params to tune a coded agent" });
  if ("error" in parsed) return void res.status(400).json({ error: parsed.error });
  setAgentLlmCredentials(agent.id, parsed);
  const updated = getAgent(agent.id)!;
  res.json({ agent: agentPayload(updated, true) });
});

// Owner-only: permanently delete an agent (its row, positions, cooldowns). Its
// dedicated wallet keeps whatever testnet balance it holds — the key is just
// forgotten. Open positions are dropped from our books but still settle
// on-chain; sweep first if you care about the winnings.
agentsRouter.delete("/agents/:id", requireAuth, (req, res) => {
  const agent = getAgent(req.params.id ?? "");
  if (!agent) return void res.status(404).json({ error: "not found" });
  if (!agent.ownerUserId || agent.ownerUserId !== (res.locals.userId as string)) {
    return void res.status(403).json({ error: "not your agent" });
  }
  deleteAgent(agent.id);
  res.json({ ok: true, deleted: agent.id });
});

agentsRouter.get("/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return void res.status(404).json({ error: "not found" });
  const records = readAgentRecords(agent.id).slice(-200).reverse();
  const isOwner = Boolean(res.locals.userId) && res.locals.userId === agent.ownerUserId;
  res.json({
    agent: agentPayload(agent, isOwner),
    stats: computeAgentStats(agent.id),
    feed: records,
    isOwner,
  });
});

// Owner-only: rewrite a coded agent's decision code from a new description. Runs
// the generation call INLINE (a deliberate button press wants immediate feedback).
agentsRouter.post("/agents/:id/regenerate", requireAuth, async (req, res) => {
  const agent = getAgent(req.params.id ?? "");
  if (!agent) return void res.status(404).json({ error: "not found" });
  if (!agent.ownerUserId || agent.ownerUserId !== (res.locals.userId as string)) {
    return void res.status(403).json({ error: "not your agent" });
  }
  if (agent.strategyKind !== "code") return void res.status(400).json({ error: "this agent is not a coded agent" });
  // Each regen is a live LLM call on the owner's key — one at a time, with a cooldown.
  const rl = hit(`regen:${agent.id}`, 1, Number(process.env.REGEN_COOLDOWN_MS ?? 45_000));
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    return void res.status(429).json({ error: `regenerating too fast — wait ${Math.ceil(rl.retryAfterMs / 1000)}s` });
  }
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (description.length === 0 || description.length > 2000) {
    return void res.status(400).json({ error: "description is required (max 2000 chars)" });
  }
  const creds = getAgentLlmCredentials(agent.id);
  if (!creds) return void res.status(400).json({ error: "this agent has no LLM key — set one first (PATCH with llmProvider + llmApiKey)" });

  setStrategyPrompt(agent.id, description);
  clearGeneratedCode(agent.id);
  const r = await generateStrategy({ description, name: agent.name, provider: creds.provider, apiKey: creds.apiKey, model: creds.model });
  if (!r.ok) {
    setCodeError(agent.id, r.error);
    return void res.status(422).json({ error: r.error });
  }
  setGeneratedStrategy(agent.id, { code: r.code, params: r.params, spec: r.spec });
  markCodeGenerated(agent.id);
  res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
});

// Owner-only: fund this agent's wallet NOW (treasury gas drip + faucet mint).
// Funding is an explicit choice — an agent never provisions itself. Idempotent.
agentsRouter.post("/agents/:id/fund", requireAuth, async (req, res) => {
  const agent = getAgent(req.params.id ?? "");
  if (!agent) return void res.status(404).json({ error: "not found" });
  if (!agent.ownerUserId || agent.ownerUserId !== (res.locals.userId as string)) {
    return void res.status(403).json({ error: "not your agent" });
  }
  if (isWalletFunded(agent.id)) {
    return void res.json({ agent: agentPayload(getAgent(agent.id)!, true), alreadyFunded: true });
  }
  const r = await fundAgent(agent);
  if (!r.ok) return void res.status(502).json({ error: r.error || "funding failed" });
  res.json({ agent: agentPayload(getAgent(agent.id)!, true) });
});

// Owner-only: run a coded agent's current code against the latest live snapshots
// and report what it WOULD decide — no trade, no log lines, no writes.
agentsRouter.post("/agents/:id/dry-run", requireAuth, async (req, res) => {
  const agent = getAgent(req.params.id ?? "");
  if (!agent) return void res.status(404).json({ error: "not found" });
  if (!agent.ownerUserId || agent.ownerUserId !== (res.locals.userId as string)) {
    return void res.status(403).json({ error: "not your agent" });
  }
  const rl = hit(`dryrun:${agent.id}`, Number(process.env.DRYRUN_PER_MIN ?? 8), 60_000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    return void res.status(429).json({ error: `dry-run rate limit — wait ${Math.ceil(rl.retryAfterMs / 1000)}s` });
  }
  const gen = getGeneratedStrategy(agent.id);
  if (!gen) return void res.status(409).json({ error: "no generated code yet" });
  const views = buildCodeMarketViews(getLatestSnapshots());
  if (views.length === 0) return void res.json({ ranAt: new Date().toISOString(), results: [], note: "no live markets in scope right now" });
  const run = await runStrategyCode(gen.code, gen.params, views, { timeoutMs: 1000 });
  if (!run.ok) return void res.json({ ranAt: new Date().toISOString(), error: `${run.kind}: ${run.message}` });

  const cfg = loadRiskConfig();
  const dailyPnlUsd = getDailyPnlUsd(agent.id);
  const results = run.results.map((r) => {
    const v = views.find((x) => x.marketId === r.marketId)!;
    if (!r.decision || v.yesMid === null) {
      return { marketId: r.marketId, symbol: v.symbol, action: "HOLD", skipReason: r.decision ? "no_market_price" : "code_no_opinion" };
    }
    const edge = r.decision.fairUpProbability - v.yesMid;
    const g = gateTrade({
      edge,
      confidence: r.decision.confidence,
      cfg,
      lastTradeAtMs: getLastTradeAtMs(agent.id, r.marketId),
      nowMs: Date.now(),
      cycleNotionalUsedUsd: 0,
      dailyPnlUsd,
    });
    const action = !g.allowed
      ? g.skipReason === "below_min_edge" || g.skipReason === "below_min_confidence"
        ? "HOLD"
        : "SKIP_RISK_GATED"
      : edge > 0
        ? "BUY_UP"
        : "BUY_DOWN";
    return {
      marketId: r.marketId,
      symbol: v.symbol,
      fairUpProbability: r.decision.fairUpProbability,
      marketImpliedUp: v.yesMid,
      edge: Math.round(edge * 1e4) / 1e4,
      confidence: r.decision.confidence,
      reasoning: r.decision.reasoning,
      action,
      skipReason: g.skipReason,
    };
  });
  res.json({ ranAt: new Date().toISOString(), results });
});

// Differentiator §6b — shareable card for an agent's current stats / big wins.
agentsRouter.get("/agents/:id/card.svg", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return void res.status(404).json({ error: "not found" });
  const svg = renderShareCard(agent, computeAgentStats(agent.id));
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-cache");
  res.send(svg);
});

// Differentiator §6c — featured head-to-head matchup between two agents on
// the most recent market they both considered (or a specific one via ?marketId=).
agentsRouter.get("/duel", (req, res) => {
  const a = req.query.a;
  const b = req.query.b;
  const marketId = typeof req.query.marketId === "string" ? req.query.marketId : undefined;
  if (typeof a !== "string" || typeof b !== "string") {
    return void res.status(400).json({ error: "a and b (agent ids) are required" });
  }
  res.json(computeDuel(a, b, marketId));
});
