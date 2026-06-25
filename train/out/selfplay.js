// train/pool.ts
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
var WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
var MatchPool = class {
  workers;
  size;
  constructor(n) {
    this.size = Math.max(1, n);
    this.workers = Array.from({ length: this.size }, () => new Worker(WORKER_FILE));
  }
  // Run a batch of matches across all workers. Resolves with replies aligned to
  // the input order: the reply for jobs[i] is at results[i]. A free worker is
  // immediately handed the next pending job, so load stays balanced even when
  // matches vary wildly in length (early crash vs long survival duel).
  run(jobs) {
    return new Promise((resolve, reject) => {
      const results = new Array(jobs.length);
      if (jobs.length === 0) return resolve(results);
      let next = 0;
      let done = 0;
      const feed = (w) => {
        if (next >= jobs.length) return;
        const id = next++;
        w.postMessage({ ...jobs[id], id });
      };
      for (const w of this.workers) {
        w.removeAllListeners("message");
        w.removeAllListeners("error");
        w.on("message", (res) => {
          results[res.id] = res;
          if (++done === jobs.length) resolve(results);
          else feed(w);
        });
        w.on("error", reject);
      }
      for (const w of this.workers) feed(w);
    });
  }
  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
};

// train/selfplay.ts
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
var POP = Number(process.env.POP ?? 20);
var GENS = Number(process.env.GENS ?? 50);
var MATCHES = Number(process.env.MATCHES ?? 10);
var ELITE = Number(process.env.ELITE ?? 4);
var FIELD = Number(process.env.FIELD ?? 4);
var STEP_CAP = Number(process.env.STEP_CAP ?? 2e3);
var GA_SEED = Number(process.env.SEED ?? 4242);
var WORKERS = Number(process.env.WORKERS ?? cpus().length);
var SIZE = process.env.SIZE ?? "small";
var HOF_MAX = Number(process.env.HOF_MAX ?? 10);
var SEED_PATH = process.env.SEED_PROFILE ?? "train/out/best-profile.json";
var CONFIG = {
  humans: 0,
  ai: FIELD,
  speed: "normal",
  difficulty: "cheating",
  map: "cross",
  size: SIZE,
  mode: "classic"
};
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = s + 1831565813 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rng = mulberry32(GA_SEED);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
var NUM_GENES = [
  { key: "aimRange", min: 2, max: 2500, int: true, sigma: 200 },
  { key: "seekRange", min: 2, max: 12e4, int: true, sigma: 2e4 },
  { key: "aimTake", min: 0, max: 1, sigma: 0.12 },
  { key: "escapeSpace", min: 0, max: 2500, int: true, sigma: 250 },
  { key: "openRate", min: 0, max: 0.8, sigma: 0.1 },
  { key: "flood", min: 20, max: 3500, int: true, sigma: 350 },
  { key: "open", min: -4, max: 8, sigma: 0.9 },
  { key: "hunt", min: 0, max: 130, sigma: 12 },
  { key: "straight", min: 0, max: 16, sigma: 1.5 },
  { key: "jitter", min: 0, max: 8, sigma: 0.9 }
];
var BOOL_GENES = ["alwaysSprint", "stalk", "breach", "pathfind", "dodge", "pacifist"];
var clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function randomizeFrom(base) {
  const g = structuredClone(base);
  g.lead = true;
  g.escape = true;
  g.seekRange = base.seekRange ?? base.aimRange;
  for (const gene of NUM_GENES) {
    let v = (g[gene.key] ?? 0) + gauss() * gene.sigma;
    v = clamp(v, gene.min, gene.max);
    g[gene.key] = gene.int ? Math.round(v) : v;
  }
  for (const b of BOOL_GENES) {
    const bv = base[b] ?? false;
    g[b] = rng() < 0.3 ? !bv : bv;
  }
  return g;
}
function mutate(g) {
  const c = structuredClone(g);
  for (const gene of NUM_GENES) if (rng() < 0.5) {
    let v = c[gene.key] + gauss() * gene.sigma * 0.6;
    c[gene.key] = gene.int ? Math.round(clamp(v, gene.min, gene.max)) : clamp(v, gene.min, gene.max);
  }
  for (const b of BOOL_GENES) if (rng() < 0.08) c[b] = !c[b];
  return c;
}
function crossover(a, b) {
  const c = structuredClone(a);
  for (const gene of NUM_GENES) if (rng() < 0.5) c[gene.key] = b[gene.key];
  for (const x of BOOL_GENES) if (rng() < 0.5) c[x] = b[x];
  return c;
}
function scoreReply(r) {
  const slot = r.slot;
  const myDeath = r.diedAt[slot];
  let outlived = 0;
  for (let i = 0; i < r.nSlots; i++) if (i !== slot && r.diedAt[i] < myDeath) outlived++;
  const placement = outlived / Math.max(1, r.nSlots - 1);
  const won = r.winnerSlot === slot ? 1 : 0;
  const totalLen = r.length.reduce((a, b) => a + b, 0) || 1;
  const territory = r.length[slot] / totalLen;
  return { s: placement + won + territory * 0.3 + r.kills[slot] * 0.05, won };
}
function sampleOpponents(pool2, genBase, evalIdx, count) {
  let h = (genBase >>> 0 ^ Math.imul(evalIdx + 1, 2654435761)) >>> 0;
  const out = [];
  for (let k = 0; k < count; k++) {
    h = Math.imul(h, 1664525) + 1013904223 >>> 0;
    out.push(pool2[h % pool2.length]);
  }
  return out;
}
function makeEvals(base, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ seed: base + i * 7919 + 1, slot: i % FIELD });
  return out;
}
var matchesRun = 0;
async function evalSet(pool2, genomes, evals, oppPool, genBase) {
  const jobs = [];
  for (const g of genomes) {
    for (let ei = 0; ei < evals.length; ei++) {
      const e = evals[ei];
      const opps = sampleOpponents(oppPool, genBase, ei, FIELD - 1);
      const profiles = { [e.slot]: g };
      let oi = 0;
      for (let sl = 0; sl < FIELD; sl++) if (sl !== e.slot) profiles[sl] = opps[oi++];
      jobs.push({ config: CONFIG, seed: e.seed, scoredSlot: e.slot, profiles, stepCap: STEP_CAP });
    }
  }
  const replies = await pool2.run(jobs);
  matchesRun += jobs.length;
  const out = genomes.map(() => ({ score: 0, wins: 0 }));
  let k = 0;
  for (let gi = 0; gi < genomes.length; gi++)
    for (let e = 0; e < evals.length; e++) {
      const sc = scoreReply(replies[k++]);
      out[gi].score += sc.s;
      out[gi].wins += sc.won;
    }
  return out;
}
var RUNGS = (() => {
  const m0 = Math.max(2, Math.round(MATCHES * 0.3));
  const m1 = Math.max(1, Math.round(MATCHES * 0.3));
  const m2 = Math.max(1, MATCHES - m0 - m1);
  return [
    { matches: m0, keep: Math.max(ELITE + 2, Math.ceil(POP * 0.4)) },
    { matches: m1, keep: Math.max(ELITE + 1, Math.ceil(POP * 0.18)) },
    { matches: m2, keep: Math.max(ELITE, Math.ceil(POP * 0.08)) }
  ];
})();
var avgOf = (s) => s.score / Math.max(1, s.played);
async function runGeneration(pool2, popList, oppPool, genBase) {
  const all = popList.map((g) => ({ g, score: 0, wins: 0, played: 0 }));
  let survivors = all.slice();
  let cursor = genBase;
  for (const rung of RUNGS) {
    const evals = makeEvals(cursor, rung.matches);
    cursor += rung.matches * 7919 + 104729;
    const res = await evalSet(pool2, survivors.map((s) => s.g), evals, oppPool, genBase);
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].score += res[i].score;
      survivors[i].wins += res[i].wins;
      survivors[i].played += rung.matches;
    }
    survivors.sort((a, b) => avgOf(b) - avgOf(a));
    survivors = survivors.slice(0, rung.keep);
  }
  return { all, survivors };
}
var seedModel = JSON.parse(readFileSync(SEED_PATH, "utf8"));
console.log(
  `Self-play co-evolution
  pop=${POP} gens=${GENS} matches/finalist=${MATCHES} field=${FIELD} workers=${WORKERS} arena=${SIZE} hof<=${HOF_MAX}
  seed model (from ${SEED_PATH}): ${JSON.stringify(seedModel)}
`
);
var pool = new MatchPool(WORKERS);
var population = [structuredClone(seedModel)];
while (population.length < POP) population.push(randomizeFrom(seedModel));
var hallOfFame = [structuredClone(seedModel)];
var logRows = ["gen,bestAvg,bestWins,meanAvg,hofSize,matchesRun"];
var champion = structuredClone(seedModel);
var t0 = Date.now();
for (let gen = 0; gen < GENS; gen++) {
  const { all, survivors } = await runGeneration(pool, population, hallOfFame, gen * 1000003);
  const top = survivors[0];
  const mean = all.reduce((s, x) => s + avgOf(x), 0) / all.length;
  champion = structuredClone(top.g);
  console.log(
    `gen ${String(gen).padStart(2)}  best=${avgOf(top).toFixed(3)} (wins ${top.wins}/${top.played})  mean=${mean.toFixed(3)}  hof=${hallOfFame.length}  [${matchesRun} matches, ${((Date.now() - t0) / 1e3).toFixed(0)}s]`
  );
  logRows.push(`${gen},${avgOf(top).toFixed(4)},${top.wins},${mean.toFixed(4)},${hallOfFame.length},${matchesRun}`);
  hallOfFame.push(structuredClone(champion));
  if (hallOfFame.length > HOF_MAX) hallOfFame = [hallOfFame[0], ...hallOfFame.slice(-(HOF_MAX - 1))];
  const elites = survivors.slice(0, ELITE).map((s) => structuredClone(s.g));
  const pick = () => {
    const a = all[Math.floor(rng() * all.length)], b = all[Math.floor(rng() * all.length)];
    return (avgOf(a) >= avgOf(b) ? a : b).g;
  };
  const next = [...elites];
  while (next.length < POP) next.push(mutate(crossover(pick(), pick())));
  population = next;
}
var valEvals = makeEvals(9e6, 80);
var vsSeed = (await evalSet(pool, [champion], valEvals, [seedModel], 9e6))[0];
var seedVsSeed = (await evalSet(pool, [seedModel], valEvals, [seedModel], 9e6))[0];
console.log("\n==== self-play champion vs a field of the original deep model (80 matches) ====");
console.log(`champion : wins=${vsSeed.wins}/80 (${(100 * vsSeed.wins / 80).toFixed(0)}%)  avg=${(vsSeed.score / 80).toFixed(3)}`);
console.log(`deep model (for reference, vs same field): wins=${seedVsSeed.wins}/80 (${(100 * seedVsSeed.wins / 80).toFixed(0)}%)`);
console.log(`(chance among ${FIELD} equals = ${(100 / FIELD).toFixed(0)}%)`);
console.log(`total matches simulated: ${matchesRun} in ${((Date.now() - t0) / 1e3).toFixed(1)}s`);
writeFileSync("train/out/selfplay-best.json", JSON.stringify(champion, null, 2));
writeFileSync("train/out/selfplay-log.csv", logRows.join("\n") + "\n");
console.log("\nwrote train/out/selfplay-best.json");
console.log("champion:", JSON.stringify(champion));
await pool.close();
