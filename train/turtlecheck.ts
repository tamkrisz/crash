// Behavioural check for the TURTLE character. Three scenarios on the REAL Game
// engine:
//   1. mixed field      — equal numbers of each character; avg survival + win rate.
//   2. self-coil (solo) — two of ONE character on a big map where they rarely meet,
//                         so match length ≈ how long before a bot traps ITSELF.
//                         This is the "gets stuck" metric the escape planner targets.
//   3. large field       — 30 bots (exercises the multi-threaded/parallel-shaped
//                         serial fallback + the escape override at scale).
//
// Build: node_modules/.bin/esbuild train/turtlecheck.ts --bundle --format=esm --platform=node --outfile=train/out/turtlecheck.js
// Run:   node train/out/turtlecheck.js

import { Game, type GameCallbacks } from "../src/game";
import type { MatchConfig, Personality } from "../src/types";

const STUB: any = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : STUB),
  apply: () => STUB,
  construct: () => STUB,
  set: () => true,
});
(globalThis as any).document = { createElement: () => STUB };

function seedRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noopCb: GameCallbacks = { onRoundOver: () => {}, onStatus: () => {} };
const game = new Game(STUB, 160, 110, 4, 640, 440, noopCb);

interface Tally {
  steps: number;
  diedAt: number[];
  winner: string | null;
  persona: string[];
}
function runMatch(config: MatchConfig, seed: number, cap: number): Tally {
  seedRandom(seed);
  game.newMatch(config);
  const players = game.players;
  const n = players.length;
  const persona = players.map((p) => p.personality ?? "balanced");
  const diedAt = new Array<number>(n).fill(Number.MAX_SAFE_INTEGER);
  const dt = players[0]?.baseInterval ?? 100;
  let steps = 0;
  while ((game as any).state === "playing" && steps < cap) {
    game.update(dt);
    steps++;
    for (let i = 0; i < n; i++) {
      if (!players[i].alive && diedAt[i] === Number.MAX_SAFE_INTEGER) diedAt[i] = steps;
    }
  }
  return { steps, diedAt, winner: game.winner?.personality ?? null, persona };
}

const cfg = (over: Partial<MatchConfig>): MatchConfig => ({
  humans: 0,
  ai: 2,
  speed: "fast",
  difficulty: "hard",
  map: "cross",
  size: "medium",
  mode: "classic",
  roster: { mode: "counts", personality: "balanced", counts: {}, pool: [] },
  ...over,
});

// ---- 1. mixed field --------------------------------------------------------
{
  const FIELD: Personality[] = ["turtle", "survivor", "balanced", "runner", "hunter", "ambusher"];
  const PER = 2;
  const MATCHES = 400;
  const CAP = 4000;
  const counts = Object.fromEntries(FIELD.map((p) => [p, PER])) as Record<Personality, number>;
  const survSum: Record<string, number> = {};
  const survCnt: Record<string, number> = {};
  const wins: Record<string, number> = {};
  for (const p of FIELD) (survSum[p] = 0), (survCnt[p] = 0), (wins[p] = 0);
  for (let m = 0; m < MATCHES; m++) {
    const r = runMatch(
      cfg({ ai: FIELD.length * PER, roster: { mode: "counts", personality: "balanced", counts, pool: [] } }),
      m * 2654435761 + 1,
      CAP,
    );
    for (let i = 0; i < r.persona.length; i++) {
      const surv = r.diedAt[i] === Number.MAX_SAFE_INTEGER ? r.steps : r.diedAt[i];
      survSum[r.persona[i]] += surv;
      survCnt[r.persona[i]]++;
    }
    if (r.winner) wins[r.winner]++;
  }
  console.log(`\n[1] MIXED FIELD — ${FIELD.length * PER} bots, hard, medium/cross, ${MATCHES} matches`);
  const rows = FIELD.map((p) => ({
    character: p,
    avgSurvival: Math.round(survSum[p] / Math.max(1, survCnt[p])),
    winRatePct: +((100 * wins[p]) / MATCHES / PER).toFixed(1),
  }));
  rows.sort((a, b) => b.avgSurvival - a.avgSurvival);
  console.table(rows);
}

// ---- 2. self-coil (two of one character, big map) --------------------------
{
  const CHARS: Personality[] = ["turtle", "survivor", "balanced", "runner"];
  const MATCHES = 300;
  const CAP = 6000;
  console.log(`\n[2] SELF-COIL — 2 same-character bots, large map, ${MATCHES} matches (match length = steps until the first traps itself; CAP=${CAP})`);
  const rows = CHARS.map((p) => {
    let sum = 0;
    let capped = 0;
    for (let m = 0; m < MATCHES; m++) {
      const r = runMatch(
        cfg({ ai: 2, size: "large", roster: { mode: "counts", personality: p, counts: { [p]: 2 }, pool: [] } }),
        m * 40503 + 7,
        CAP,
      );
      sum += r.steps;
      if (r.steps >= CAP) capped++;
    }
    return { character: p, avgMatchLen: Math.round(sum / MATCHES), reachedCapPct: +((100 * capped) / MATCHES).toFixed(1) };
  });
  rows.sort((a, b) => b.avgMatchLen - a.avgMatchLen);
  console.table(rows);
}

// ---- 3. large field (parallel-shaped) --------------------------------------
{
  const FIELD: Personality[] = ["turtle", "survivor", "balanced", "hunter"];
  const PER = 8; // 32 bots
  const MATCHES = 120;
  const CAP = 4000;
  const counts = Object.fromEntries(FIELD.map((p) => [p, PER])) as Record<Personality, number>;
  const survSum: Record<string, number> = {};
  const survCnt: Record<string, number> = {};
  const wins: Record<string, number> = {};
  for (const p of FIELD) (survSum[p] = 0), (survCnt[p] = 0), (wins[p] = 0);
  for (let m = 0; m < MATCHES; m++) {
    const r = runMatch(
      cfg({ ai: FIELD.length * PER, size: "large", roster: { mode: "counts", personality: "balanced", counts, pool: [] } }),
      m * 974711 + 3,
      CAP,
    );
    for (let i = 0; i < r.persona.length; i++) {
      const surv = r.diedAt[i] === Number.MAX_SAFE_INTEGER ? r.steps : r.diedAt[i];
      survSum[r.persona[i]] += surv;
      survCnt[r.persona[i]]++;
    }
    if (r.winner) wins[r.winner]++;
  }
  console.log(`\n[3] LARGE FIELD — ${FIELD.length * PER} bots, hard, large, ${MATCHES} matches`);
  const rows = FIELD.map((p) => ({
    character: p,
    avgSurvival: Math.round(survSum[p] / Math.max(1, survCnt[p])),
    winRatePct: +((100 * wins[p]) / MATCHES / PER).toFixed(1),
  }));
  rows.sort((a, b) => b.avgSurvival - a.avgSurvival);
  console.table(rows);
}
