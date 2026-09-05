// Append-only JSONL decision log, one file per agent per day. Bot is the sole
// writer; the dashboard/API only ever reads. Three record `type`s share one
// stream (see types.ts) so a reader can tail a single file per agent.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "./types.js";

const LOG_DIR = process.env.AGENT_ARENA_LOG_DIR ?? join(process.cwd(), "logs");

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function agentDir(agentId: string): string {
  const dir = join(LOG_DIR, agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendRecord(record: LogRecord): void {
  const file = join(agentDir(record.agentId), `decisions-${dayStamp()}.jsonl`);
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

/** All records for an agent, oldest first, across every day file on disk. */
export function readAgentRecords(agentId: string): LogRecord[] {
  const dir = join(LOG_DIR, agentId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: LogRecord[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogRecord);
      } catch {
        // Skip a torn line (e.g. process killed mid-write) rather than fail the whole read.
      }
    }
  }
  return out;
}

/** Every agentId that has at least one log file on disk. */
export function listLoggedAgentIds(): string[] {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
