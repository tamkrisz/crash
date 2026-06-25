// Self-play / co-evolution. Instead of fighting a FIXED reference field (that's
// evolve.ts), candidates here fight COPIES OF THEMSELVES: each match fills the
// non-candidate slots with profiles drawn from a hall of fame of champions — seeded
// with the deep cheating-hunter model (train/out/best-profile.json) and grown with
// each generation's winner. The hall of fame (rather than only the latest champion)
// keeps the population from cycling — a counter that only beats today's champion but
// loses to last week's can't take over. Output: train/out/selfplay-best.json.
//
// Reuses the parallel pool (pool.ts/worker.ts), which now injects a full per-slot
// profile map, so we can place a different bot in every slot.

import { MatchPool } from "./pool";
import type { MatchReply } from "./worker";
import type { AiProfile, MatchConfig } from "../src/types";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

// ---- knobs ------------------------------------------------------------------
const POP = Number(process.env.POP ?? 20);
const GENS = Number(process.env.GENS ?? 50);
const MATCHES = Number(process.env.MATCHES ?? 10);
const ELITE = Number(process.env.ELITE ?? 4);
const FIELD = Number(process.env.FIELD ?? 4);
const STEP_CAP = Number(process.env.STEP_CAP ?? 2000);
const GA_SEED = Number(process.env.SEED ?? 4242);
const WORKERS = Number(process.env.WORKERS ?? cpus().length);
const SIZE = (process.env.SIZE ?? "small") as MatchConfig["size"];
const HOF_MAX = Number(process.env.HOF_MAX ?? 10);
const SEED_PATH = process.env.SEED_PROFILE ?? "train/out/best-profile.json";

// difficulty/roster are irrelevant — every slot is overridden with an injected
// profile (candidate + sampled opponents fill all FIELD slots).
const CONFIG: MatchConfig = {
  humans: 0, ai: FIELD, speed: "normal", difficulty: "cheating",
  map: "cross", size: SIZE, mode: "classic",
};

// ---- GA PRNG (separate from match seeding) ----------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(GA_SEED);
function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- genome spec (same bounds as evolve.ts) ---------------------------------
interface NumGene { key: keyof AiProfile; min: number; max: number; int?: boolean; sigma: number; }
const NUM_GENES: NumGene[] = [
  { key: "aimRange", min: 2, max: 2500, int: true, sigma: 200 },
  { key: "seekRange", min: 2, max: 120000, int: true, sigma: 20000 },
  { key: "aimTake", min: 0, max: 1, sigma: 0.12 },
  { key: "escapeSpace", min: 0, max: 2500, int: true, sigma: 250 },
  { key: "openRate", min: 0, max: 0.8, sigma: 0.1 },
  { key: "flood", min: 20, max: 3500, int: true, sigma: 350 },
  { key: "open", min: -4, max: 8, sigma: 0.9 },
  { key: "hunt", min: 0, max: 130, sigma: 12 },
  { key: "straight", min: 0, max: 16, sigma: 1.5 },
  { key: "jitter", min: 0, max: 8, sigma: 0.9 },
];
const BOOL_GENES: (keyof AiProfile)[] = ["alwaysSprint", "stalk", "breach", "pathfind", "dodge", "pacifist"];
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function randomizeFrom(base: AiProfile): AiProfile {
  const g: AiProfile = structuredClone(base);
  g.lead = true; g.escape = true;
  g.seekRange = base.seekRange ?? base.aimRange;
  for (const gene of NUM_GENES) {
    let v = ((g[gene.key] as number) ?? 0) + gauss() * gene.sigma;
    v = clamp(v, gene.min, gene.max);
    (g[gene.key] as number) = gene.int ? Math.round(v) : v;
  }
  for (const b of BOOL_GENES) {
    const bv = (base[b] as boolean) ?? false;
    (g[b] as boolean) = rng() < 0.3 ? !bv : bv;
  }
  return g;
}
function mutate(g: AiProfile): AiProfile {
  const c = structuredClone(g);
  for (const gene of NUM_GENES) if (rng() < 0.5) {
    let v = (c[gene.key] as number) + gauss() * gene.sigma * 0.6;
    (c[gene.key] as number) = gene.int ? Math.round(clamp(v, gene.min, gene.max)) : clamp(v, gene.min, gene.max);
  }
  for (const b of BOOL_GENES) if (rng() < 0.08) (c[b] as boolean) = !(c[b] as boolean);
  return c;
}
function crossover(a: AiProfile, b: AiProfile): AiProfile {
  const c = structuredClone(a);
  for (const gene of NUM_GENES) if (rng() < 0.5) (c[gene.key] as number) = b[gene.key] as number;
  for (const x of BOOL_GENES) if (rng() < 0.5) (c[x] as boolean) = b[x] as boolean;
  return c;
}

// ---- scoring (placement + win + territory tiebreak) -------------------------
function scoreReply(r: MatchReply): { s: number; won: number } {
  const slot = r.slot;
  const myDeath = r.diedAt[slot];
  let outlived = 0;
  for (let i = 0; i < r.nSlots; i++) if (i !== slot && r.diedAt[i] < myDeath) outlived++;
  const placement = outlived / Math.max(1, r.nSlots - 1);
  const won = r.winnerSlot === slot ? 1 : 0;
  const totalLen = r.length.reduce((a, b) => a + b, 0) || 1;
  const territory = r.length[slot] / totalLen; // 0..1, breaks all-survive draws
  return { s: placement + won + territory * 0.3 + r.kills[slot] * 0.05, won };
}

// ---- opponent sampling (deterministic per eval, so all candidates face the
// same field on the same seed — common random numbers) ------------------------
function sampleOpponents(pool: AiProfile[], genBase: number, evalIdx: number, count: number): AiProfile[] {
  let h = ((genBase >>> 0) ^ Math.imul(evalIdx + 1, 2654435761)) >>> 0;
  const out: AiProfile[] = [];
  for (let k = 0; k < count; k++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push(pool[h % pool.length]);
  }
  return out;
}

interface Eval { seed: number; slot: number; }
function makeEvals(base: number, count: number): Eval[] {
  const out: Eval[] = [];
  for (let i = 0; i < count; i++) out.push({ seed: base + i * 7919 + 1, slot: i % FIELD });
  return out;
}

let matchesRun = 0;
async function evalSet(
  pool: MatchPool, genomes: AiProfile[], evals: Eval[], oppPool: AiProfile[], genBase: number,
): Promise<{ score: number; wins: number }[]> {
  const jobs = [];
  for (const g of genomes) {
    for (let ei = 0; ei < evals.length; ei++) {
      const e = evals[ei];
      const opps = sampleOpponents(oppPool, genBase, ei, FIELD - 1);
      const profiles: Record<number, AiProfile> = { [e.slot]: g };
      let oi = 0;
      for (let sl = 0; sl < FIELD; sl++) if (sl !== e.slot) profiles[sl] = opps[oi++];
      jobs.push({ config: CONFIG, seed: e.seed, scoredSlot: e.slot, profiles, stepCap: STEP_CAP });
    }
  }
  const replies = await pool.run(jobs);
  matchesRun += jobs.length;
  const out = genomes.map(() => ({ score: 0, wins: 0 }));
  let k = 0;
  for (let gi = 0; gi < genomes.length; gi++)
    for (let e = 0; e < evals.length; e++) {
      const sc = scoreReply(replies[k++]);
      out[gi].score += sc.s; out[gi].wins += sc.won;
    }
  return out;
}

// ---- successive-halving generation ------------------------------------------
interface Rung { matches: number; keep: number; }
const RUNGS: Rung[] = (() => {
  const m0 = Math.max(2, Math.round(MATCHES * 0.3));
  const m1 = Math.max(1, Math.round(MATCHES * 0.3));
  const m2 = Math.max(1, MATCHES - m0 - m1);
  return [
    { matches: m0, keep: Math.max(ELITE + 2, Math.ceil(POP * 0.4)) },
    { matches: m1, keep: Math.max(ELITE + 1, Math.ceil(POP * 0.18)) },
    { matches: m2, keep: Math.max(ELITE, Math.ceil(POP * 0.08)) },
  ];
})();

interface Scored { g: AiProfile; score: number; wins: number; played: number; }
const avgOf = (s: Scored) => s.score / Math.max(1, s.played);

async function runGeneration(
  pool: MatchPool, popList: AiProfile[], oppPool: AiProfile[], genBase: number,
): Promise<{ all: Scored[]; survivors: Scored[] }> {
  const all: Scored[] = popList.map((g) => ({ g, score: 0, wins: 0, played: 0 }));
  let survivors = all.slice();
  let cursor = genBase;
  for (const rung of RUNGS) {
    const evals = makeEvals(cursor, rung.matches);
    cursor += rung.matches * 7919 + 104729;
    const res = await evalSet(pool, survivors.map((s) => s.g), evals, oppPool, genBase);
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].score += res[i].score; survivors[i].wins += res[i].wins; survivors[i].played += rung.matches;
    }
    survivors.sort((a, b) => avgOf(b) - avgOf(a));
    survivors = survivors.slice(0, rung.keep);
  }
  return { all, survivors };
}

// ---- run --------------------------------------------------------------------
const seedModel: AiProfile = JSON.parse(readFileSync(SEED_PATH, "utf8"));
console.log(
  `Self-play co-evolution\n` +
    `  pop=${POP} gens=${GENS} matches/finalist=${MATCHES} field=${FIELD} workers=${WORKERS} ` +
    `arena=${SIZE} hof<=${HOF_MAX}\n` +
    `  seed model (from ${SEED_PATH}): ${JSON.stringify(seedModel)}\n`,
);

const pool = new MatchPool(WORKERS);
let population: AiProfile[] = [structuredClone(seedModel)];
while (population.length < POP) population.push(randomizeFrom(seedModel));

let hallOfFame: AiProfile[] = [structuredClone(seedModel)]; // opponents drawn from here
const logRows = ["gen,bestAvg,bestWins,meanAvg,hofSize,matchesRun"];
let champion: AiProfile = structuredClone(seedModel);
const t0 = Date.now();

for (let gen = 0; gen < GENS; gen++) {
  const { all, survivors } = await runGeneration(pool, population, hallOfFame, gen * 1_000_003);
  const top = survivors[0];
  const mean = all.reduce((s, x) => s + avgOf(x), 0) / all.length;
  champion = structuredClone(top.g);

  console.log(
    `gen ${String(gen).padStart(2)}  best=${avgOf(top).toFixed(3)} (wins ${top.wins}/${top.played})  ` +
      `mean=${mean.toFixed(3)}  hof=${hallOfFame.length}  [${matchesRun} matches, ${((Date.now() - t0) / 1000).toFixed(0)}s]`,
  );
  logRows.push(`${gen},${avgOf(top).toFixed(4)},${top.wins},${mean.toFixed(4)},${hallOfFame.length},${matchesRun}`);

  // grow the hall of fame with this gen's champion (keep the seed + most recent)
  hallOfFame.push(structuredClone(champion));
  if (hallOfFame.length > HOF_MAX) hallOfFame = [hallOfFame[0], ...hallOfFame.slice(-(HOF_MAX - 1))];

  // breed next gen: elites verbatim, rest tournament -> crossover -> mutate
  const elites = survivors.slice(0, ELITE).map((s) => structuredClone(s.g));
  const pick = (): AiProfile => {
    const a = all[Math.floor(rng() * all.length)], b = all[Math.floor(rng() * all.length)];
    return (avgOf(a) >= avgOf(b) ? a : b).g;
  };
  const next: AiProfile[] = [...elites];
  while (next.length < POP) next.push(mutate(crossover(pick(), pick())));
  population = next;
}

// ---- head-to-head: self-play champion vs a field of the ORIGINAL deep model --
const valEvals = makeEvals(9_000_000, 80);
const vsSeed = (await evalSet(pool, [champion], valEvals, [seedModel], 9_000_000))[0];
const seedVsSeed = (await evalSet(pool, [seedModel], valEvals, [seedModel], 9_000_000))[0];
console.log("\n==== self-play champion vs a field of the original deep model (80 matches) ====");
console.log(`champion : wins=${vsSeed.wins}/80 (${((100 * vsSeed.wins) / 80).toFixed(0)}%)  avg=${(vsSeed.score / 80).toFixed(3)}`);
console.log(`deep model (for reference, vs same field): wins=${seedVsSeed.wins}/80 (${((100 * seedVsSeed.wins) / 80).toFixed(0)}%)`);
console.log(`(chance among ${FIELD} equals = ${(100 / FIELD).toFixed(0)}%)`);
console.log(`total matches simulated: ${matchesRun} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

writeFileSync("train/out/selfplay-best.json", JSON.stringify(champion, null, 2));
writeFileSync("train/out/selfplay-log.csv", logRows.join("\n") + "\n");
console.log("\nwrote train/out/selfplay-best.json");
console.log("champion:", JSON.stringify(champion));

await pool.close();
