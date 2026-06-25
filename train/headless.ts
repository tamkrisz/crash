// Headless match runner. Drives the REAL ../src/game.ts Game class with no canvas
// and no rendering, so evolved profiles are scored against the exact same AI and
// physics the browser game runs. Nothing under src/ is modified — we only:
//   * stub `document` + a 2D canvas context (a self-returning Proxy) so the Game
//     constructor and newMatch (which build gradients / a bg pattern) don't crash,
//   * seed Math.random with a per-match PRNG for reproducible rollouts,
//   * read/overwrite the public Player.aiProfile field to inject candidate genomes.
//
// The single-threaded serial path runs the COMPLETE brain (aiChoose + shooting +
// sprint) inside Game — steer.ts (the worker port) is never touched here, and the
// parallel path stays off (Node has no global Worker, and we keep fields small).

import { Game, type GameCallbacks } from "../src/game";
import type { AiProfile, MatchConfig } from "../src/types";

// ---- browser stubs ---------------------------------------------------------

// A Proxy that is callable, constructable, indexable and assignable, and returns
// itself for every access — so ctx.createLinearGradient(...).addColorStop(...),
// canvas.getContext("2d"), document.createElement("canvas"), etc. all no-op
// without ever throwing. update()/the sim never read meaningful values off it.
const STUB: any = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : STUB),
  apply: () => STUB,
  construct: () => STUB,
  set: () => true,
});

function installStubs(): void {
  const g = globalThis as any;
  if (g.__crashHeadlessStubs) return;
  if (!g.document) g.document = { createElement: () => STUB };
  g.__crashHeadlessStubs = true;
}

// mulberry32 — small, fast, fully reproducible. Overriding the global Math.random
// makes every Math.random() call inside Game (spawn jitter, steering jitter, shot
// rolls) deterministic for a given seed without editing a single source file.
export function seedRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- one reusable Game instance --------------------------------------------

installStubs();

const noopCb: GameCallbacks = { onRoundOver: () => {}, onStatus: () => {} };

// Dimensions here are placeholders; newMatch -> resize() sets the real grid from
// the MatchConfig. cell/viewW/viewH only ever matter for rendering, which is off.
let game: Game | null = null;
function getGame(): Game {
  if (!game) game = new Game(STUB, 160, 110, 4, 640, 440, noopCb);
  return game;
}

// Read one freshly-built baseline profile straight out of the Game (i.e. exactly
// what buildProfile(difficulty, "balanced") produces) to seed the population and
// to use as the reference opponents. Avoids re-deriving the tuning by hand.
export function baselineProfile(cfg: MatchConfig): AiProfile {
  const g = getGame();
  seedRandom(1);
  g.newMatch({ ...cfg, humans: 0, ai: 2 });
  const bot = g.players.find((p) => p.type === "ai")!;
  return structuredClone(bot.aiProfile!);
}

// ---- a single match --------------------------------------------------------

export interface MatchOpts {
  config: MatchConfig;
  seed: number;
  // aiProfile to install per AI slot, by slot index. Slots not present keep the
  // profile Game already built from the config's difficulty.
  profiles: Record<number, AiProfile>;
  // which slot we're scoring (for survival/kill readout convenience)
  stepCap?: number;
}

export interface MatchResult {
  winnerSlot: number | null; // player id of the survivor, or null on a draw/cap
  steps: number; // sim steps elapsed
  diedAt: number[]; // step each slot died (Infinity-ish = survived to the end)
  kills: number[]; // per-slot kills
  length: number[]; // per-slot trail length
  nSlots: number;
}

export function runMatch(opts: MatchOpts): MatchResult {
  const g = getGame();
  const cap = opts.stepCap ?? 4000;

  seedRandom(opts.seed);
  g.newMatch(opts.config);

  const players = g.players;
  for (const [slot, prof] of Object.entries(opts.profiles)) {
    const p = players[Number(slot)];
    if (p && p.type === "ai") p.aiProfile = prof;
  }

  const n = players.length;
  const diedAt = new Array<number>(n).fill(Number.MAX_SAFE_INTEGER);
  const dt = players[0]?.baseInterval ?? 100;

  let steps = 0;
  while ((g as any).state === "playing" && steps < cap) {
    g.update(dt);
    steps++;
    for (let i = 0; i < n; i++) {
      if (!players[i].alive && diedAt[i] === Number.MAX_SAFE_INTEGER) diedAt[i] = steps;
    }
  }

  return {
    winnerSlot: g.winner ? g.winner.id : null,
    steps,
    diedAt,
    kills: players.map((p) => p.kills),
    length: players.map((p) => p.length),
    nSlots: n,
  };
}
