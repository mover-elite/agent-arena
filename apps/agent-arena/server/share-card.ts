// Differentiator §6b: a shareable card for an agent's big-win moments.
// Pure SVG (no rasterization dependency — kept deliberately dependency-free)
// served as `image/svg+xml`, which every modern browser and most social
// unfurlers render directly; wrap it in an <img> anywhere that needs a PNG.

import type { Agent } from "./types.js";
import type { AgentStats } from "./stats.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** SVG <text> doesn't wrap on its own — break into up to `maxLines` lines of
 *  roughly `charsPerLine` characters, truncating with an ellipsis on overflow. */
function wrapLines(s: string, charsPerLine: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > charsPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = truncate(lines[maxLines - 1]!, charsPerLine);
  }
  return lines;
}

export function renderShareCard(agent: Agent, stats: AgentStats): string {
  const pnlColor = stats.pnlUsd >= 0 ? "#5ce08a" : "#f2777a";
  const pnlText = `${stats.pnlUsd >= 0 ? "+" : ""}${stats.pnlUsd.toFixed(2)}`;
  const brierText = stats.avgBrier !== null ? stats.avgBrier.toFixed(4) : "—";
  const badge = stats.isAtPersonalBest ? "NEW PERSONAL BEST" : `${agent.mode.toUpperCase()} AGENT`;
  const strategyLines = wrapLines(agent.strategyPrompt, 68, 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#12151c"/>
      <stop offset="100%" stop-color="#0b0d12"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#232733" stroke-width="2"/>
  <text x="60" y="90" font-family="-apple-system, Helvetica, sans-serif" font-size="22" font-weight="700" fill="#4d7cff" letter-spacing="2">AGENT ARENA</text>
  <text x="60" y="118" font-family="-apple-system, Helvetica, sans-serif" font-size="16" fill="#8b93a7">DreamDEX Event Contracts · Somnia</text>

  <rect x="60" y="150" width="260" height="36" rx="18" fill="${stats.isAtPersonalBest ? "#1f3a2a" : "#232733"}"/>
  <text x="190" y="174" font-family="-apple-system, Helvetica, sans-serif" font-size="15" font-weight="700" fill="${stats.isAtPersonalBest ? "#5ce08a" : "#a9b1c3"}" text-anchor="middle" letter-spacing="1">${esc(badge)}</text>

  <text x="60" y="260" font-family="-apple-system, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#e6e8ee">${esc(truncate(agent.name, 28))}</text>
  <text x="60" y="305" font-family="-apple-system, Helvetica, sans-serif" font-size="19" fill="#c3c9d6">${strategyLines.map((line, i) => `<tspan x="60" dy="${i === 0 ? 0 : 26}">${esc(line)}</tspan>`).join("")}</text>

  <text x="60" y="440" font-family="-apple-system, Helvetica, sans-serif" font-size="17" fill="#8b93a7">P&amp;L (USD)</text>
  <text x="60" y="490" font-family="-apple-system, Helvetica, sans-serif" font-size="56" font-weight="700" fill="${pnlColor}">${esc(pnlText)}</text>

  <text x="420" y="440" font-family="-apple-system, Helvetica, sans-serif" font-size="17" fill="#8b93a7">Settled markets</text>
  <text x="420" y="490" font-family="-apple-system, Helvetica, sans-serif" font-size="56" font-weight="700" fill="#e6e8ee">${stats.settledCount}</text>

  <text x="720" y="440" font-family="-apple-system, Helvetica, sans-serif" font-size="17" fill="#8b93a7">Avg Brier score</text>
  <text x="720" y="490" font-family="-apple-system, Helvetica, sans-serif" font-size="56" font-weight="700" fill="#e6e8ee">${esc(brierText)}</text>

  <text x="60" y="580" font-family="-apple-system, Helvetica, sans-serif" font-size="15" fill="#5b6478">Every trade, reasoned in the open — agent-arena.local</text>
</svg>`;
}
