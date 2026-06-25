// Differential test for the ported steering helpers in steer.ts.
// Build first:  npx esbuild src/ai/steer.ts --bundle --format=esm --outfile=/tmp/steer.mjs
// Run:          node src/ai/steer.test.mjs
// Each helper is checked against an INDEPENDENT brute-force reference over many
// random worlds — a transcription bug in the port would have to be duplicated in
// the reference to slip through.
import { __test, makeScratch, chooseSteer } from "/tmp/steer.mjs";

const EMPTY = -1,
  WALL = -2;
const SPATIAL_TILE = 16;
const DELTA = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

let seed = 99173;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function buildWorld(cols, rows, nplayers, wallDensity) {
  const grid = new Int16Array(cols * rows).fill(EMPTY);
  for (let k = 0; k < cols * rows * wallDensity; k++) {
    grid[(rnd() * cols * rows) | 0] = WALL;
  }
  const n = nplayers;
  const px = new Int32Array(n),
    py = new Int32Array(n),
    pdir = new Int8Array(n),
    palive = new Uint8Array(n),
    pcharged = new Uint8Array(n),
    pescapeSteps = new Int32Array(n),
    paiCooldown = new Int32Array(n),
    pai = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    px[i] = (rnd() * cols) | 0;
    py[i] = (rnd() * rows) | 0;
    pdir[i] = (rnd() * 4) | 0;
    palive[i] = rnd() > 0.15 ? 1 : 0;
    pcharged[i] = rnd() > 0.5 ? 1 : 0;
    grid[py[i] * cols + px[i]] = EMPTY; // heads sit on free cells
  }
  // spatial CSR over alive players
  const tilesX = Math.max(1, Math.ceil(cols / SPATIAL_TILE));
  const tilesY = Math.max(1, Math.ceil(rows / SPATIAL_TILE));
  const nt = tilesX * tilesY;
  const tileStart = new Int32Array(nt + 1);
  for (let i = 0; i < n; i++) {
    if (!palive[i]) continue;
    const t = ((py[i] / SPATIAL_TILE) | 0) * tilesX + ((px[i] / SPATIAL_TILE) | 0);
    tileStart[t + 1]++;
  }
  for (let t = 0; t < nt; t++) tileStart[t + 1] += tileStart[t];
  const cursor = Int32Array.from(tileStart.subarray(0, nt));
  const tileItems = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!palive[i]) continue;
    const t = ((py[i] / SPATIAL_TILE) | 0) * tilesX + ((px[i] / SPATIAL_TILE) | 0);
    tileItems[cursor[t]++] = i;
  }
  const f64 = () => new Float64Array(n);
  return {
    cols, rows, n, grid,
    px, py, pdir, palive, pcharged, pescapeSteps, paiCooldown, pai,
    tilesX, tilesY, tileStart, tileItems,
    profHunt: f64(), profSeek: f64(), profFlood: f64(),
    profOpen: f64(), profStraight: f64(), profJitter: f64(),
    profStalk: new Uint8Array(n), profPathfind: new Uint8Array(n),
    profAvoid: f64(), profAvoidRange: f64(), profNoCoast: new Uint8Array(n),
  };
}

// ---- brute-force references ----
const wrapDelta = (d, nn) => {
  let m = ((d % nn) + nn) % nn;
  if (m > nn / 2) m -= nn;
  return m;
};
const wrapX = (w, x) => ((x % w.cols) + w.cols) % w.cols;
const wrapY = (w, y) => ((y % w.rows) + w.rows) % w.rows;
const refIdx = (w, x, y) => wrapY(w, y) * w.cols + wrapX(w, x);
const refFree = (w, x, y) => w.grid[refIdx(w, x, y)] === EMPTY;

function refFlood(w, sx, sy, cap) {
  const seen = new Set();
  const q = [refIdx(w, sx, sy)];
  seen.add(q[0]);
  let count = 0,
    head = 0;
  while (head < q.length && count < cap) {
    const cur = q[head++];
    count++;
    const x = cur % w.cols,
      y = (cur - x) / w.cols;
    for (let d = 0; d < 4; d++) {
      const nx = x + DELTA[d].x,
        ny = y + DELTA[d].y;
      if (!refFree(w, nx, ny)) continue;
      const ni = refIdx(w, nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      q.push(ni);
    }
  }
  return count;
}
function refOpenness(w, cx, cy, r) {
  let free = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (refFree(w, cx + dx, cy + dy)) free++;
  return free;
}
function refNearest(w, i, range) {
  // EXACT nearest (the spatial version is "within ~one tile of slack"); we only
  // assert the spatial result is a valid rival and no worse than slack off exact.
  let best = -1,
    bestD = Infinity;
  for (let q = 0; q < w.n; q++) {
    if (!w.palive[q] || q === i) continue;
    const d =
      Math.abs(wrapDelta(w.px[q] - w.px[i], w.cols)) +
      Math.abs(wrapDelta(w.py[q] - w.py[i], w.rows));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return { best, bestD: best >= 0 && bestD <= range ? bestD : Infinity };
}
function refClearAhead(w, i, dir, cap) {
  const dx = DELTA[dir].x,
    dy = DELTA[dir].y;
  for (let k = 1; k <= cap; k++)
    if (!refFree(w, w.px[i] + dx * k, w.py[i] + dy * k)) return k - 1;
  return cap;
}

// ---- run ----
let floodFails = 0,
  openFails = 0,
  nearFails = 0,
  nearSlack = 0,
  maxSlack = 0,
  clearFails = 0,
  chooseBad = 0,
  checks = 0;

for (let it = 0; it < 1500; it++) {
  const cols = 20 + ((rnd() * 180) | 0);
  const rows = 20 + ((rnd() * 180) | 0);
  const nn = 1 + ((rnd() * 50) | 0);
  const w = buildWorld(cols, rows, nn, rnd() * 0.3);
  const s = makeScratch(cols, rows);
  for (let i = 0; i < w.n; i++) {
    if (!w.palive[i]) continue;
    const cap = [20, 60, 200, 600][(rnd() * 4) | 0];
    // flood
    if (__test.floodCount(w, s, w.px[i], w.py[i], cap) !== refFlood(w, w.px[i], w.py[i], cap))
      floodFails++;
    // openness
    if (__test.openness(w, w.px[i], w.py[i], 3) !== refOpenness(w, w.px[i], w.py[i], 3))
      openFails++;
    // clearAhead
    if (
      __test.clearAhead(w, i, w.pdir[i], 6) !== refClearAhead(w, i, w.pdir[i], 6)
    )
      clearFails++;
    // nearest (allow up to one tile of slack vs exact, never invalid)
    const range = [6, 24, 100000][(rnd() * 3) | 0];
    const got = __test.nearestRival(w, i, range);
    const ref = refNearest(w, i, range);
    if (ref.bestD === Infinity) {
      if (got !== -1) nearFails++; // we found one where exact says none in range
    } else if (got < 0 || !w.palive[got] || got === i) {
      nearFails++;
    } else {
      const gd =
        Math.abs(wrapDelta(w.px[got] - w.px[i], w.cols)) +
        Math.abs(wrapDelta(w.py[got] - w.py[i], w.rows));
      const slack = gd - ref.bestD;
      if (slack > SPATIAL_TILE) nearFails++;
      else if (slack > 0) {
        nearSlack++;
        maxSlack = Math.max(maxSlack, slack);
      }
    }
    // chooseSteer must return a valid Dir; if any non-back dir is free, the
    // chosen cell must be free (never knowingly steers into a wall).
    w.profFlood[i] = cap;
    w.profOpen[i] = rnd() * 2;
    w.profStraight[i] = rnd() * 5;
    w.profJitter[i] = 0;
    const dir = chooseSteer(w, s, i);
    if (dir < 0 || dir > 3) chooseBad++;
    else {
      const back = (w.pdir[i] + 2) % 4;
      let anyFree = false;
      for (let d = 0; d < 4; d++)
        if (d !== back && refFree(w, w.px[i] + DELTA[d].x, w.py[i] + DELTA[d].y))
          anyFree = true;
      if (anyFree && !refFree(w, w.px[i] + DELTA[dir].x, w.py[i] + DELTA[dir].y))
        chooseBad++;
    }
    checks++;
  }
}

console.log({
  checks,
  floodFails,
  openFails,
  clearFails,
  nearFails,
  nearSlack,
  maxSlack,
  chooseBad,
});
const ok =
  floodFails === 0 &&
  openFails === 0 &&
  clearFails === 0 &&
  nearFails === 0 &&
  chooseBad === 0;
console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
