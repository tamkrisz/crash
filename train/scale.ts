// 500-hunter survival benchmark. Spawns a big field of hunters and tracks how
// many are alive over time, plus WHY the dead died: own-blast, rival-blast, or
// collision (rammed wall/trail/another hunter). 5 real seconds at normal speed
// (~80ms/step) is ~62 steps, so the "alive@~5s" column is the user's complaint.

import { Game, type GameCallbacks } from "../src/game";
import type { MatchConfig, AiRoster } from "../src/types";
import { seedRandom } from "./headless";

const STUB: any = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : STUB),
  apply: () => STUB, construct: () => STUB, set: () => true,
});
(globalThis as any).document ??= { createElement: () => STUB };

const N = Number(process.env.N ?? 500);
const SIZE = (process.env.SIZE as any) ?? "large";
const MODE = (process.env.MODE as any) ?? "classic";
const roster: AiRoster = { mode: "uniform", personality: (process.env.CHAR as any) ?? "hunter", counts: {}, pool: [] };
const config: MatchConfig = { humans: 0, ai: N, speed: "normal", difficulty: "hard",
  map: process.env.MAP ?? "cross", size: SIZE, mode: MODE, roster };
const cb: GameCallbacks = { onRoundOver: () => {}, onStatus: () => {} };
const game = new Game(STUB, 160, 110, 4, 640, 440, cb);
const g = game as any;
const DELTA = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

let ownBlast = 0, rivalBlast = 0, collide = 0;
const blastVictim = new Map<number, "own" | "rival">();
const origDet = g.detonate.bind(g);
g.detonate = (cx: number, cy: number, owner?: number) => {
  const before = game.players.map((p) => p.alive);
  origDet(cx, cy, owner);
  for (const p of game.players) if (before[p.id] && !p.alive) blastVictim.set(p.id, p.id === owner ? "own" : "rival");
};

const SEEDS = Number(process.env.SEEDS ?? 3);
const checkpoints = [10, 30, 62, 120, 250, 500];
const aliveAt: Record<number, number> = {};
for (const c of checkpoints) aliveAt[c] = 0;
let runs = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
  seedRandom(seed);
  game.newMatch(config);
  console.log(`field=${game.players.length} on ${game.cols}x${game.rows} (${(game.cols*game.rows/game.players.length)|0} cells/cycle)`);
  const prevAlive = game.players.map(() => true);
  const dt = game.players[0].baseInterval;
  let steps = 0;
  while (g.state === "playing" && steps < 600) {
    blastVictim.clear();
    game.update(dt);
    steps++;
    for (const p of game.players) {
      if (prevAlive[p.id] && !p.alive) {
        prevAlive[p.id] = false;
        const bv = blastVictim.get(p.id);
        if (bv === "own") ownBlast++; else if (bv === "rival") rivalBlast++; else collide++;
      }
    }
    if (checkpoints.includes(steps)) aliveAt[steps] += game.aliveCount;
  }
  // if the round ended before a checkpoint, the survivor count holds
  for (const c of checkpoints) if (steps < c) aliveAt[c] += game.aliveCount;
  runs++;
}

console.log(`\n${N} hunters, ${runs} runs — alive over time (avg):`);
for (const c of checkpoints) console.log(`  step ${String(c).padStart(3)} (~${(c*0.08).toFixed(1)}s): ${(aliveAt[c] / runs).toFixed(0)} alive / ${N}`);
const totalDeaths = ownBlast + rivalBlast + collide;
console.log(`\ndeath causes (${totalDeaths} total): ownBlast=${ownBlast} (${(100*ownBlast/totalDeaths).toFixed(0)}%)  rivalBlast=${rivalBlast} (${(100*rivalBlast/totalDeaths).toFixed(0)}%)  collide=${collide} (${(100*collide/totalDeaths).toFixed(0)}%)`);
