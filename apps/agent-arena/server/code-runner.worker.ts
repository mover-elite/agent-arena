// Runs inside a worker_threads sandbox (spawned by code-runner.ts). Receives
// { code, params, markets } via workerData, evaluates the generated arrow
// function ONCE, calls it per market, validates each result, and posts back a
// single message. Never imports anything but the shared strategy lib.

import { parentPort, workerData } from "node:worker_threads";
// NOTE: explicit `.ts` specifiers — a worker loaded by URL bypasses tsx's
// `.js` -> `.ts` remapping (see tsconfig `allowImportingTsExtensions`).
import { LIB } from "./strategy-lib.ts";
import type { CodeDecision, CodeMarketView } from "./types.ts";

type Msg =
  | { ok: true; results: Array<{ marketId: string; decision: CodeDecision | null }> }
  | { ok: false; kind: "compile" | "throw" | "bad_return"; message: string };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function isProb(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1;
}

function validate(d: unknown): { decision: CodeDecision | null } | { error: string } {
  if (d === null || d === undefined) return { decision: null };
  if (typeof d !== "object") return { error: `decide() returned a ${typeof d}, expected an object or null` };
  const o = d as Record<string, unknown>;
  if (!isProb(o.fairUpProbability)) return { error: "fairUpProbability must be a number strictly between 0 and 1" };
  if (!isProb(o.confidence)) return { error: "confidence must be a number strictly between 0 and 1" };
  if (typeof o.reasoning !== "string" || o.reasoning.trim().length === 0) return { error: "reasoning must be a non-empty string" };
  return {
    decision: {
      fairUpProbability: o.fairUpProbability,
      confidence: o.confidence,
      reasoning: o.reasoning.trim().slice(0, 500),
    },
  };
}

function main(): Msg {
  const { code, params, markets } = workerData as {
    code: string;
    params: Record<string, unknown>;
    markets: CodeMarketView[];
  };

  let fn: unknown;
  try {
    // eslint-disable-next-line no-eval
    fn = (0, eval)("(" + code + "\n)");
  } catch (e) {
    return { ok: false, kind: "compile", message: (e as Error).message };
  }
  if (typeof fn !== "function") return { ok: false, kind: "compile", message: "generated code is not a function expression" };

  const frozenParams = deepFreeze(params);
  const results: Array<{ marketId: string; decision: CodeDecision | null }> = [];
  for (const market of markets) {
    let raw: unknown;
    try {
      raw = (fn as (m: unknown, p: unknown, l: unknown) => unknown)(deepFreeze(market), frozenParams, LIB);
    } catch (e) {
      return { ok: false, kind: "throw", message: `decide() threw: ${(e as Error).message}` };
    }
    const v = validate(raw);
    if ("error" in v) return { ok: false, kind: "bad_return", message: v.error };
    results.push({ marketId: market.marketId, decision: v.decision });
  }
  return { ok: true, results };
}

parentPort?.postMessage(main());
