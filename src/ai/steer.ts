// Pure, side-effect-free AI STEERING — a faithful port of Game.aiChoose and its
// helpers (floodCount, openness, nearestRival, pathToward, aimBonus, manhattan,
// clearAhead) that operates ONLY on plain typed arrays + scalars. No `this`, no
// canvas, no DOM — so it can run inside a Web Worker over SharedArrayBuffer-backed
// state. The single-threaded Game keeps its own copy of this logic; this module is
// what the worker pool runs. The two MUST stay behaviourally identical — they share
// ./constants, and any change to the steering algorithm in game.ts must be mirrored
// here (and is covered by ai/steer.test.mjs). Shooting/sprint stay on the main
// thread (they mutate game state) and are NOT ported here.

import { DELTA, opposite, type Dir } from "../types";
import {
  EMPTY,
  OPEN_RADIUS,
  PF_RANGE,
  PF_NODES,
  PF_WALL_COST,
  PF_PATH_BONUS,
  PF_MIN_FLOOD,
  PF_MAX_WALL_RUN,
  PF_WALL_RUN_PENALTY,
  HUNT_MIN_FLOOD,
  SPATIAL_TILE,
  AI_THINK_PERIOD,
  AI_STAGGER_MIN_CYCLES,
  COAST_RUNWAY,
  COAST_OPEN_MIN,
} from "./constants";

// Read-only shared snapshot of the world + roster. Backed by SharedArrayBuffer
// views in the worker; by plain typed arrays on the main thread. Every field here
// is READ by steering and written only by the main thread between think passes.
export interface SteerWorld {
  cols: number;
  rows: number;
  n: number; // number of player slots
  grid: Int16Array; // len cols*rows, EMPTY (-1) = free

  // player Structure-of-Arrays (index === player id)
  px: Int32Array;
  py: Int32Array;
  pdir: Int8Array; // Dir 0..3 — READ as current heading, WRITTEN with the choice
  palive: Uint8Array; // 0/1
  pcharged: Uint8Array; // 0/1 (precomputed charge >= CHARGE_MAX)
  pescapeSteps: Int32Array;
  paiCooldown: Int32Array; // staggered-think cooldown (read + written)
  pai: Uint8Array; // 0/1 — is this slot an AI cycle (humans are skipped)

  // spatial bucket grid (CSR), rebuilt by the main thread each think pass
  tilesX: number;
  tilesY: number;
  tileStart: Int32Array; // len tilesX*tilesY + 1
  tileItems: Int32Array; // len >= n

  // flattened per-player AI profile (only the knobs steering reads)
  profHunt: Float64Array;
  profSeek: Float64Array; // resolved seekRange ?? aimRange
  profFlood: Float64Array;
  profOpen: Float64Array;
  profStraight: Float64Array;
  profJitter: Float64Array;
  profStalk: Uint8Array; // 0/1
  profPathfind: Uint8Array; // 0/1
  profAvoid: Float64Array; // rival-repulsion weight (the turtle); 0 = off
  profAvoidRange: Float64Array; // resolved avoidRange ?? seekRange ?? aimRange
  profNoCoast: Uint8Array; // 0/1 — never coast, replan every step (the turtle)
}

// Per-worker PRIVATE scratch. floodCount/pathToward stamp into these without
// clearing them; each worker (and the main thread) needs its OWN set so concurrent
// floods never collide. The *Gen fields are monotonic stamp generations.
export interface SteerScratch {
  stamp: Int32Array; // len cols*rows
  stampGen: number;
  floodQueue: Int32Array; // len cols*rows
  pfDist: Float64Array; // len cols*rows
  pfStamp: Int32Array; // len cols*rows
  pfNext: Int8Array; // len cols*rows
  pfHeap: Float64Array; // len 1<<16
  pfGen: number;
}

export function makeScratch(cols: number, rows: number): SteerScratch {
  const n = cols * rows;
  return {
    stamp: new Int32Array(n),
    stampGen: 0,
    floodQueue: new Int32Array(n),
    pfDist: new Float64Array(n),
    pfStamp: new Int32Array(n),
    pfNext: new Int8Array(n),
    pfHeap: new Float64Array(1 << 16),
    pfGen: 0,
  };
}

// ---- torus helpers (mirror Game.wrapX/wrapY/idx/isFree) --------------------

function wrapX(w: SteerWorld, x: number): number {
  return ((x % w.cols) + w.cols) % w.cols;
}
function wrapY(w: SteerWorld, y: number): number {
  return ((y % w.rows) + w.rows) % w.rows;
}
function idx(w: SteerWorld, x: number, y: number): number {
  return wrapY(w, y) * w.cols + wrapX(w, x);
}
function isFree(w: SteerWorld, x: number, y: number): boolean {
  return w.grid[idx(w, x, y)] === EMPTY;
}
function wrapDelta(d: number, n: number): number {
  let m = ((d % n) + n) % n;
  if (m > n / 2) m -= n;
  return m;
}

// ---- flood fill: reachable open area from (sx,sy), capped at `cap` ----------

function floodCount(
  w: SteerWorld,
  s: SteerScratch,
  sx: number,
  sy: number,
  cap: number,
): number {
  const cols = w.cols;
  const rows = w.rows;
  const grid = w.grid;
  const stamp = s.stamp;
  const gen = ++s.stampGen;
  const queue = s.floodQueue;
  const start = idx(w, sx, sy);
  queue[0] = start;
  stamp[start] = gen;
  let count = 0;
  let head = 0;
  let tail = 1;
  while (head < tail && count < cap) {
    const cur = queue[head++];
    count++;
    const x = cur % cols;
    const y = (cur - x) / cols;
    // queue cells are in-grid, so each neighbour is at most one step out of
    // range — one branch per axis wraps it (no double modulo), index once.
    for (let d = 0; d < 4; d++) {
      let nx = x + DELTA[d].x;
      let ny = y + DELTA[d].y;
      if (nx < 0) nx += cols;
      else if (nx >= cols) nx -= cols;
      if (ny < 0) ny += rows;
      else if (ny >= rows) ny -= rows;
      const ni = ny * cols + nx;
      if (grid[ni] !== EMPTY) continue;
      if (stamp[ni] === gen) continue;
      stamp[ni] = gen;
      queue[tail++] = ni;
    }
  }
  return count;
}

// ---- openness: free cells in a (2r+1)^2 box ---------------------------------

function openness(w: SteerWorld, cx: number, cy: number, r: number): number {
  const cols = w.cols;
  const rows = w.rows;
  const grid = w.grid;
  let free = 0;
  for (let dy = -r; dy <= r; dy++) {
    let yy = cy + dy;
    if (yy < 0) yy += rows;
    else if (yy >= rows) yy -= rows;
    const row = yy * cols;
    for (let dx = -r; dx <= r; dx++) {
      let xx = cx + dx;
      if (xx < 0) xx += cols;
      else if (xx >= cols) xx -= cols;
      if (grid[row + xx] === EMPTY) free++;
    }
  }
  return free;
}

// ---- clear cells straight ahead of player i, capped at `cap` ----------------

function clearAhead(w: SteerWorld, i: number, dir: Dir, cap: number): number {
  const dx = DELTA[dir].x;
  const dy = DELTA[dir].y;
  const x = w.px[i];
  const y = w.py[i];
  for (let k = 1; k <= cap; k++) {
    if (!isFree(w, x + dx * k, y + dy * k)) return k - 1;
  }
  return cap;
}

// ---- contiguous breakable-cell run from (x,y) heading `d`, capped -----------
// MUST stay identical to Game.wallRunAhead. Used by pathToward to make a route
// crossing more than PF_MAX_WALL_RUN consecutive walls near-impassable.

function wallRunAhead(w: SteerWorld, x: number, y: number, d: Dir): number {
  let run = 0;
  for (let k = 0; k <= PF_MAX_WALL_RUN; k++) {
    if (w.grid[idx(w, x + DELTA[d].x * k, y + DELTA[d].y * k)] === EMPTY) break;
    run++;
  }
  return run;
}

// ---- nearest living rival to player i within toroidal Manhattan `range` -----
// Returns the rival's index, or -1. Mirrors Game.nearestRival (tile-ring walk).

function nearestRival(w: SteerWorld, i: number, range: number): number {
  const tx = w.tilesX;
  const ty = w.tilesY;
  const px = w.px[i];
  const py = w.py[i];
  const ptx = (px / SPATIAL_TILE) | 0;
  const pty = (py / SPATIAL_TILE) | 0;
  const maxR = Math.min(
    Math.ceil(Math.max(tx, ty) / 2),
    Math.ceil(range / SPATIAL_TILE) + 1,
  );

  let best = -1;
  let bestD = range + 1;
  let foundRing = -1;

  for (let r = 0; r <= maxR; r++) {
    if (foundRing >= 0 && r > foundRing + 1) break;
    for (let dy = -r; dy <= r; dy++) {
      const edgeY = dy === -r || dy === r;
      for (let dx = -r; dx <= r; dx++) {
        if (!edgeY && dx !== -r && dx !== r) continue;
        const cx = (((ptx + dx) % tx) + tx) % tx;
        const cy = (((pty + dy) % ty) + ty) % ty;
        const t = cy * tx + cx;
        const e = w.tileStart[t + 1];
        for (let k = w.tileStart[t]; k < e; k++) {
          const q = w.tileItems[k];
          if (!w.palive[q] || q === i) continue;
          const qdx = Math.abs(wrapDelta(w.px[q] - px, w.cols));
          const qdy = Math.abs(wrapDelta(w.py[q] - py, w.rows));
          const d = qdx + qdy;
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
      }
    }
    if (best >= 0 && foundRing < 0) foundRing = r;
  }
  return best;
}

function manhattan(w: SteerWorld, a: number, b: number): number {
  const dx = Math.abs(wrapDelta(w.px[a] - w.px[b], w.cols));
  const dy = Math.abs(wrapDelta(w.py[a] - w.py[b], w.rows));
  return dx + dy;
}

// ---- steering reward for moving dir `d` toward target t ---------------------

function aimBonus(w: SteerWorld, i: number, d: Dir, t: number): number {
  const dx = wrapDelta(w.px[t] - w.px[i], w.cols);
  const dy = wrapDelta(w.py[t] - w.py[i], w.rows);
  const v = DELTA[d];
  let b = v.x * Math.sign(dx) + v.y * Math.sign(dy);
  if (dx === 0 && d === (dy > 0 ? 2 : 0)) b += 3;
  if (dy === 0 && d === (dx > 0 ? 1 : 3)) b += 3;
  return b;
}

// ---- breach-aware Dijkstra: first step of the shortest path from i to t ------

function pathToward(
  w: SteerWorld,
  s: SteerScratch,
  i: number,
  t: number,
): Dir | null {
  const n = w.cols * w.rows;
  const dist = s.pfDist;
  const stamp = s.pfStamp;
  const next = s.pfNext;
  const heap = s.pfHeap;
  const HMAX = heap.length;
  const gen = ++s.pfGen;

  let hlen = 0;
  const push = (key: number): void => {
    if (hlen >= HMAX) return; // budget guard: drop overflow (path may be suboptimal)
    let j = hlen++;
    heap[j] = key;
    while (j > 0) {
      const par = (j - 1) >> 1;
      if (heap[par] <= heap[j]) break;
      const tmp = heap[par];
      heap[par] = heap[j];
      heap[j] = tmp;
      j = par;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap[--hlen];
    if (hlen > 0) {
      heap[0] = last;
      let j = 0;
      for (;;) {
        const l = 2 * j + 1;
        const r = l + 1;
        let sm = j;
        if (l < hlen && heap[l] < heap[sm]) sm = l;
        if (r < hlen && heap[r] < heap[sm]) sm = r;
        if (sm === j) break;
        const tmp = heap[sm];
        heap[sm] = heap[j];
        heap[j] = tmp;
        j = sm;
      }
    }
    return top;
  };

  const src = idx(w, w.px[t], w.py[t]);
  const goal = idx(w, w.px[i], w.py[i]);
  dist[src] = 0;
  stamp[src] = gen;
  push(src);

  let pops = 0;
  let reached = false;
  while (hlen > 0 && pops < PF_NODES) {
    const key = pop();
    const cell = key % n;
    const cost = (key - cell) / n;
    if (stamp[cell] === gen && dist[cell] < cost) continue;
    if (cell === goal) {
      reached = true;
      break;
    }
    pops++;
    const cx = cell % w.cols;
    const cy = (cell - cx) / w.cols;
    const wt = w.grid[cell] === EMPTY ? 1 : PF_WALL_COST;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      const nx = wrapX(w, cx + DELTA[d].x);
      const ny = wrapY(w, cy + DELTA[d].y);
      const nc = idx(w, nx, ny);
      // Near-impassable penalty for entering a wall that begins a run of MORE
      // than PF_MAX_WALL_RUN consecutive walls in the hunter's travel direction
      // (opposite(d): we expand FROM the target). MUST match Game.pathToward.
      const extra =
        w.grid[nc] !== EMPTY &&
        wallRunAhead(w, nx, ny, opposite(d)) > PF_MAX_WALL_RUN
          ? PF_WALL_RUN_PENALTY
          : 0;
      const nd = cost + wt + extra;
      if (stamp[nc] !== gen || nd < dist[nc]) {
        stamp[nc] = gen;
        dist[nc] = nd;
        next[nc] = opposite(d);
        push(nd * n + nc);
      }
    }
  }

  if (!reached && stamp[goal] !== gen) return null;
  return next[goal] as Dir;
}

// ---- the steering choice for AI player i (port of Game.aiChoose) ------------

export function chooseSteer(
  w: SteerWorld,
  s: SteerScratch,
  i: number,
): Dir {
  const cur = w.pdir[i] as Dir;
  const back = opposite(cur);
  const px = w.px[i];
  const py = w.py[i];

  // breaking out of a freshly blasted hole: commit straight only while TWO cells
  // ahead are clear (we sprint through an escape, so a single-cell check would
  // ram the wall behind the hole). MUST match Game.aiChoose.
  if (w.pescapeSteps[i] > 0 && clearAhead(w, i, cur, 2) >= 2) {
    return cur;
  }

  const hunt = w.profHunt[i];
  const wantTarget = hunt > 0 && (w.pcharged[i] !== 0 || w.profStalk[i] !== 0);
  const target = wantTarget ? nearestRival(w, i, w.profSeek[i]) : -1;

  // The turtle's avoidance target — the nearest rival to flee from (see aiChoose).
  const avoid = w.profAvoid[i];
  const avoidTarget = avoid ? nearestRival(w, i, w.profAvoidRange[i]) : -1;

  const pathDir =
    w.profPathfind[i] !== 0 && target >= 0 && manhattan(w, i, target) <= PF_RANGE
      ? pathToward(w, s, i, target)
      : null;

  const flood = w.profFlood[i];
  const open = w.profOpen[i];
  const straight = w.profStraight[i];
  const jitter = w.profJitter[i];

  let bestDir = cur;
  let bestScore = -Infinity;

  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
    if (d === back) continue;
    const nx = px + DELTA[d].x;
    const ny = py + DELTA[d].y;
    if (!isFree(w, nx, ny)) continue;

    const room = floodCount(w, s, nx, ny, flood);
    let score = room;
    if (pathDir !== null && d === pathDir && room >= PF_MIN_FLOOD) {
      score += PF_PATH_BONUS;
    }
    score += openness(w, nx, ny, OPEN_RADIUS) * open;
    // withhold the hunt bonus when the cell floods to less than HUNT_MIN_FLOOD
    // room (chasing into a near-trap boxes the hunter) — mirrors Game.aiChoose.
    if (target >= 0 && room >= HUNT_MIN_FLOOD) score += aimBonus(w, i, d, target) * hunt;
    // avoidance: inverse of the hunt term — flee the rival, stay off its line
    // (mirrors Game.aiChoose). A nudge; flood/openness still dominate.
    if (avoidTarget >= 0 && avoid) score -= aimBonus(w, i, d, avoidTarget) * avoid;
    if (d === cur) score += straight;
    score += Math.random() * jitter;

    if (score > bestScore) {
      bestScore = score;
      bestDir = d;
    }
  }
  return bestDir;
}

// ---- one staggered plan step for AI player i (port of Game.aiThink's gate) ---
// Writes the chosen heading into w.pdir[i] and updates w.paiCooldown[i]. Coasts
// (keeps heading, decrements cooldown) only while cruising demonstrably open
// arena; otherwise runs the full chooseSteer. Steering only — the caller still
// runs aiMaybeShoot/aiSprint/move serially on the main thread.
export function planOne(w: SteerWorld, s: SteerScratch, i: number): void {
  const cur = w.pdir[i] as Dir;
  const nx = w.px[i] + DELTA[cur].x;
  const ny = w.py[i] + DELTA[cur].y;
  const canCoast =
    w.profNoCoast[i] === 0 && // the turtle never coasts — replans every step
    w.n >= AI_STAGGER_MIN_CYCLES &&
    w.paiCooldown[i] > 0 &&
    w.pescapeSteps[i] === 0 &&
    clearAhead(w, i, cur, COAST_RUNWAY) >= COAST_RUNWAY &&
    openness(w, nx, ny, OPEN_RADIUS) >= COAST_OPEN_MIN;
  if (canCoast) {
    w.paiCooldown[i] = w.paiCooldown[i] - 1;
  } else {
    w.pdir[i] = chooseSteer(w, s, i);
    w.paiCooldown[i] = AI_THINK_PERIOD;
  }
}

// Test-only handle on the internal helpers, so ai/steer.test.mjs can diff them
// against independent brute-force references (catches port/index/wrap bugs).
export const __test = { floodCount, openness, nearestRival, clearAhead, idx, isFree };

// Process a contiguous slice of a due-list (used by the worker to handle its
// stripe). `due` holds AI player indices to plan this pass.
export function planSlice(
  w: SteerWorld,
  s: SteerScratch,
  due: Int32Array,
  from: number,
  to: number,
  step: number,
): void {
  for (let k = from; k < to; k += step) {
    planOne(w, s, due[k]);
  }
}
