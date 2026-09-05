// Preset strategies — a curated gallery so a consumer can spin up an agent in
// one click instead of writing a strategy from a blank box. A preset is just a
// name + a natural-language strategy prompt: picking one is identical to typing
// that prompt yourself, so every agent it creates is still a normal LLM
// reasoning loop with the same feed, risk gates, and Brier scoring. Served at
// GET /api/strategy-presets and accepted as `presetId` on POST /api/agents.
//
// The prompts only reference what an agent actually sees each cycle — the YES
// order book, the market's implied Up probability, this process's own rolling
// mid history, and seconds-to-expiry. No external price/news feed exists in
// that context, so none of these tell the model to use one.

export interface StrategyPreset {
  id: string;
  name: string;
  /** One line for the gallery card. */
  blurb: string;
  /** The strategy/personality prompt — what a user would otherwise type. */
  prompt: string;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "momentum",
    name: "Momentum Rider",
    blurb: "Rides steady one-way probability trends into expiry.",
    prompt:
      "Momentum trader. When the recent Up-probability history is trending steadily in one direction with little noise, treat that move as likely to continue toward expiry and estimate a fair probability further along that trend than the current market price. Stay flat on markets whose history is flat, choppy, or reversing. Be more willing to act the stronger and cleaner the trend, and less willing as expiry gets very close and there is little room left to move.",
  },
  {
    id: "fade",
    name: "Fade the Crowd",
    blurb: "Bets sharp, unexplained probability spikes revert toward 50%.",
    prompt:
      "Contrarian mean-reversion trader. When the market's implied Up probability has jumped sharply in one direction over the recent history with no obvious follow-through, lean against it: estimate a fair probability closer to where it was before the spike, and often closer to 0.5. Do not fade a slow, steady drift — only fast moves that look like an overreaction. Size conviction by how stretched the move looks versus the prior range.",
  },
  {
    id: "range",
    name: "Range Fader",
    blurb: "Fades small wiggles when the market sits near a coin-flip.",
    prompt:
      "Range trader for balanced markets. When the implied Up probability has been hovering near 0.5 within a tight band and the order book is tight on both sides, treat small deviations from the middle of that band as noise and estimate a fair probability back toward the band's center. Do not trade when the probability has broken out of its recent range or when one side of the book is much thinner than the other.",
  },
  {
    id: "convergence",
    name: "Late Convergence",
    blurb: "Only acts near expiry, betting the outcome is already decided.",
    prompt:
      "End-of-window specialist. Ignore markets with lots of time left. In the final stretch before expiry, when the implied Up probability is clearly on one side of 0.5 and the recent history has stopped moving much, estimate a fair probability pushed further toward the decided outcome (toward 1 if Up is ahead, toward 0 if behind) — the closer to expiry and the more settled the price, the stronger the push. Stay flat whenever the outcome still looks genuinely uncertain.",
  },
  {
    id: "spread",
    name: "Spread Sniper",
    blurb: "Trades only when the book is wide and the mid looks mispriced.",
    prompt:
      "Liquidity-aware trader. Only act when the YES order book is wide (a large gap between best bid and best ask). In that case treat the current mid as a weak signal and estimate your own fair probability from the recent history and how much time remains, taking the side the mid has drifted away from. When the book is tight, assume the market price is efficient and stay flat.",
  },
  {
    id: "conservative",
    name: "Conservative Value",
    blurb: "Rare, high-conviction trades only when the edge is large.",
    prompt:
      "Patient value trader. Most cycles, do nothing. Only estimate a fair probability that differs meaningfully from the market price when the recent history and time-to-expiry give a clear, specific reason, and only report high confidence when that reason is strong. Prefer being flat to taking a marginal edge. Never chase a move that has already happened.",
  },
];

export function getPreset(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((p) => p.id === id);
}
