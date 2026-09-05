// Executes a generated `decide(market, params, lib)` function in a worker_threads
// sandbox — one throwaway worker per call, so "pure, stateless function" is true
// by construction. The worker has its own heap + event loop: an infinite loop is
// killed by `worker.terminate()`, a crash/OOM takes down only the worker.
//
// This is NOT a hard security boundary (the worker realm still has `fetch`/
// `process` by name), but the eval'd function only ever *receives* market/params/
// lib, the code is the agent owner's own, and it can only affect their own agent.
// A static-reject pass blocks the obvious escapes before a worker is even spawned.

import { Worker } from "node:worker_threads";
import type { CodeDecision, CodeMarketView } from "./types.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.STRATEGY_CODE_TIMEOUT_MS ?? 500);
const MAX_CODE_LEN = 8_000;

export type RunErrKind = "static_reject" | "compile" | "timeout" | "throw" | "bad_return" | "worker";

export interface RunOk {
  ok: true;
  results: Array<{ marketId: string; decision: CodeDecision | null }>;
}
export interface RunErr {
  ok: false;
  kind: RunErrKind;
  message: string;
}

/** Cheap gate before spawning a worker. Returns an error message, or null if clean. */
export function staticReject(code: string): string | null {
  if (typeof code !== "string" || code.trim().length === 0) return "code is empty";
  if (code.length > MAX_CODE_LEN) return `code too long (${code.length} > ${MAX_CODE_LEN} chars)`;
  const banned: [RegExp, string][] = [
    [/\brequire\b/, "require is not allowed"],
    [/\bprocess\b/, "process is not allowed"],
    [/\bglobalThis\b/, "globalThis is not allowed"],
    [/\bfetch\b/, "fetch is not allowed"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest is not allowed"],
    [/\bWebSocket\b/, "WebSocket is not allowed"],
    [/\beval\b/, "eval is not allowed"],
    [/\bFunction\s*\(/, "the Function constructor is not allowed"],
    [/\bimport\b/, "import is not allowed"],
    [/\bimport\s*\(/, "dynamic import is not allowed"],
    [/\basync\b/, "the function must be synchronous (no async)"],
    [/\bawait\b/, "the function must be synchronous (no await)"],
    [/while\s*\(\s*true\s*\)/, "unbounded while(true) loop"],
    [/for\s*\(\s*;\s*;\s*\)/, "unbounded for(;;) loop"],
  ];
  for (const [re, msg] of banned) if (re.test(code)) return msg;
  return null;
}

export async function runStrategyCode(
  code: string,
  params: Record<string, unknown>,
  markets: CodeMarketView[],
  opts?: { timeoutMs?: number },
): Promise<RunOk | RunErr> {
  const rej = staticReject(code);
  if (rej) return { ok: false, kind: "static_reject", message: rej };

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let worker: Worker | undefined;
  try {
    // The worker entry is a `.ts` file, so the worker thread needs tsx's ESM
    // loader registered explicitly. `process.execArgv` does NOT reliably carry
    // it into a worker: when the app runs under the bare `tsx` bin (the Docker
    // CMD), tsx's re-exec flags there don't propagate the ESM hooks, and the
    // worker dies with "Unknown file extension .ts". `--import tsx/esm` is
    // double-register-safe, so set it unconditionally.
    worker = new Worker(new URL("./code-runner.worker.ts", import.meta.url), {
      workerData: { code, params: structuredClone(params), markets },
      execArgv: ["--import", "tsx/esm"],
    });
  } catch (e) {
    return { ok: false, kind: "worker", message: (e as Error).message };
  }

  const w = worker;
  return await new Promise<RunOk | RunErr>((resolve) => {
    let done = false;
    const finish = (r: RunOk | RunErr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, kind: "timeout", message: `strategy code exceeded ${timeoutMs}ms` }), timeoutMs);

    w.once("message", (msg: { ok: true; results: RunOk["results"] } | { ok: false; kind: RunErrKind; message: string }) => {
      finish(msg.ok ? { ok: true, results: msg.results } : { ok: false, kind: msg.kind, message: msg.message });
    });
    w.once("error", (e) => finish({ ok: false, kind: "worker", message: e.message }));
    w.once("exit", (exitCode) => {
      if (!done) finish({ ok: false, kind: "worker", message: `worker exited (code ${exitCode}) before returning` });
    });
  });
}
