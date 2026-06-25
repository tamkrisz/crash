// Route A: evolve a strong AiProfile by simulating a ton of headless matches.
//
// A candidate genome IS an AiProfile (the same knobs the browser game drives bots
// with). Each generation scores genomes by dropping them into a field of stock
// reference bots and playing many seeded matches; fitness rewards outliving rivals
// and winning. Elites carry over; the rest are bred by tournament selection ->
// uniform crossover -> Gaussian mutation. End product: train/out/best-profile.json.
//
// Speed:
//   (1) Matches run on a pool of worker threads (one per core) — pool.ts/worker.ts.
//   (2) Successive halving: each generation evaluates all genomes on a few matches,
//       culls the weakest, and only spends the full match budget on survivors.
//
// Nothing under src/ is touched: candidates are scored with the REAL Game (via the
// workers' ./headless). The GA's own randomness uses a private PRNG (rng) because
// matches reseed the GLOBAL Math.random inside each worker.

import { baselineProfile } from "./headless";
import { MatchPool } from "./pool";
import type { MatchReply } from "./worker";
import type { AiProfile, MatchConfig } from "../src/types";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";

// ---- knobs (env-overridable) ------------------------------------------------
const POP = Number(process.env.POP ?? 20);
const GENS = Number(process.env.GENS ?? 8);
const MATCHES = Number(process.env.MATCHES ?? 16); // full budget for a finalist
const ELITE = Number(process.env.ELITE ?? 4);
const FIELD = Number(process.env.FIELD ?? 6);
const STEP_CAP = Number(process.env.STEP_CAP ?? 3000);
const GA_SEED = Number(process.env.SEED ?? 1234);
const WORKERS = Number(process.env.WORKERS ?? cpus().length);
const DIFFICULTY = (process.env.DIFFICULTY ?? "cheating") as MatchConfig["difficulty"];
const PERSONA = (process.env.PERSONA ?? "hunter") as
  | "balanced" | "hunter" | "packer" | "runner" | "survivor" | "demolisher" | "roamer" | "ambusher";

const CONFIG: MatchConfig = {
  humans: 0,
  ai: FIELD,
  speed: "normal",
  difficulty: DIFFICULTY, // reference opponents the candidate must beat
  map: "cross",
  size: (process.env.SIZE ?? "medium") as MatchConfig["size"],
  mode: "classic",
  // every reference bot is this character (default: the cheating HUNTER)
  roster: { mode: "uniform", personality: PERSONA, counts: {}, pool: [] },
};

// ---- successive-halving schedule -------------------------------------------
// Each rung runs `matches` NEW matches per surviving genome (added to its running
// score), then keeps the top `keep`. Rung match counts sum to MATCHES, so a
// finalist plays the full budget while weak genomes are dropped after a few games.
interface Rung { matches: number; keep: number; }
function defaultRungs(): Rung[] {
  const m0 = Math.max(3, Math.round(MATCHES * 0.25));
  const m1 = Math.max(1, Math.round(MATCHES * 0.25));
  const m2 = Math.max(1, MATCHES - m0 - m1);
  return [
    { matches: m0, keep: Math.max(ELITE + 2, Math.ceil(POP * 0.4)) },
    { matches: m1, keep: Math.max(ELITE + 1, Math.ceil(POP * 0.16)) },
    { matches: m2, keep: Math.max(ELITE, Math.ceil(POP * 0.08)) },
  ];
}
function parseRungs(s: string | undefined): Rung[] | null {
  if (!s) return null;
  return s.split(",").map((part) => {
    const [m, k] = part.split(":").map(Number);
    return { matches: m, keep: k };
  });
}
const RUNGS = parseRungs(process.env.RUNGS) ?? defaultRungs();

// ---- private PRNG for GA operators (NOT the match PRNG) ----------------------
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

// ---- genome spec ------------------------------------------------------------
interface NumGene { key: keyof AiProfile; min: number; max: number; int?: boolean; sigma: number; }
// Bounds are wide enough to MATCH AND EXCEED the cheating-hunter reference
// (aimRange ~1800, flood ~2500, escapeSpace ~1560, hunt ~90, seekRange 1e5), so a
// candidate isn't capped below the bots it must beat. The population is seeded from
// that profile, so Gaussian mutation explores around those large starting values.
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
// pacifist is in the mix: against a field of breaching hunters, a pure evasive
// survivor that lets them kill each other can beat trying to out-hunt them.
const BOOL_GENES: (keyof AiProfile)[] = ["alwaysSprint", "stalk", "breach", "pathfind", "dodge", "pacifist"];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function randomizeFrom(base: AiProfile): AiProfile {
  const g: AiProfile = structuredClone(base);
  g.lead = true;
  g.escape = true; // both unambiguously good; not evolved
  g.seekRange = base.seekRange ?? base.aimRange;
  for (const gene of NUM_GENES) {
    const cur = (g[gene.key] as number) ?? 0;
    let v = cur + gauss() * gene.sigma;
    v = clamp(v, gene.min, gene.max);
    (g[gene.key] as number) = gene.int ? Math.round(v) : v;
  }
  // seed toggles from the reference (hunter traits mostly ON), flip ~30% to explore
  for (const b of BOOL_GENES) {
    const bv = (base[b] as boolean) ?? false;
    (g[b] as boolean) = rng() < 0.3 ? !bv : bv;
  }
  return g;
}

function mutate(g: AiProfile): AiProfile {
  const c = structuredClone(g);
  for (const gene of NUM_GENES) {
    if (rng() < 0.5) {
      let v = (c[gene.key] as number) + gauss() * gene.sigma * 0.6;
      v = clamp(v, gene.min, gene.max);
      (c[gene.key] as number) = gene.int ? Math.round(v) : v;
    }
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

// ---- scoring ----------------------------------------------------------------
interface Eval { seed: number; slot: number; }
function makeEvals(base: number, count: number): Eval[] {
  const out: Eval[] = [];
  for (let i = 0; i < count; i++) out.push({ seed: base + i * 7919 + 1, slot: i % FIELD });
  return out;
}

function scoreReply(r: MatchReply): { s: number; won: number } {
  const slot = r.slot;
  const myDeath = r.diedAt[slot];
  let outlived = 0;
  for (let i = 0; i < r.nSlots; i++) {
    if (i === slot) continue;
    if (r.diedAt[i] < myDeath) outlived++;
  }
  const placement = outlived / Math.max(1, r.nSlots - 1); // 0..1
  const won = r.winnerSlot === slot ? 1 : 0;
  return { s: placement + won + r.kills[slot] * 0.05, won };
}

let matchesRun = 0;

// Score a set of genomes over `evals`, in parallel. Returns per-genome totals
// aligned to the input order. Jobs are genome-major and contiguous so we can
// fold the flat reply array back per genome without echoing extra metadata.
async function evalSet(
  pool: MatchPool,
  genomes: AiProfile[],
  evals: Eval[],
): Promise<{ score: number; wins: number }[]> {
  const jobs = [];
  for (const g of genomes)
    for (const e of evals)
      jobs.push({ config: CONFIG, seed: e.seed, scoredSlot: e.slot, profiles: { [e.slot]: g }, stepCap: STEP_CAP });

  const replies = await pool.run(jobs);
  matchesRun += jobs.length;

  const out = genomes.map(() => ({ score: 0, wins: 0 }));
  let k = 0;
  for (let gi = 0; gi < genomes.length; gi++) {
    for (let e = 0; e < evals.length; e++) {
      const sc = scoreReply(replies[k++]);
      out[gi].score += sc.s;
      out[gi].wins += sc.won;
    }
  }
  return out;
}

interface Scored { g: AiProfile; score: number; wins: number; played: number; }
const avgOf = (s: Scored) => s.score / Math.max(1, s.played);

// One generation with successive halving. Mutates the Scored records in place
// (survivors share references with `all`), so `all` ends up holding each genome's
// accumulated score over however many matches it survived to play.
async function runGeneration(
  pool: MatchPool,
  pop: AiProfile[],
  base: AiProfile,
  genBase: number,
): Promise<{ all: Scored[]; survivors: Scored[]; refAvg: number; refWins: number }> {
  const all: Scored[] = pop.map((g) => ({ g, score: 0, wins: 0, played: 0 }));
  let survivors = all.slice();
  let seedCursor = genBase;
  let lastEvals: Eval[] = [];

  for (const rung of RUNGS) {
    const evals = makeEvals(seedCursor, rung.matches);
    seedCursor += rung.matches * 7919 + 104729;
    lastEvals = evals;

    const res = await evalSet(pool, survivors.map((s) => s.g), evals);
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].score += res[i].score;
      survivors[i].wins += res[i].wins;
      survivors[i].played += rung.matches;
    }
    survivors.sort((a, b) => avgOf(b) - avgOf(a));
    survivors = survivors.slice(0, rung.keep);
  }

  // reference yardstick: stock bot on the final rung's seeds (full budget)
  const refTotal = makeEvals(genBase, MATCHES);
  const refRes = (await evalSet(pool, [base], refTotal))[0];

  return {
    all,
    survivors,
    refAvg: refRes.score / refTotal.length,
    refWins: refRes.wins,
  };
}

// ---- run --------------------------------------------------------------------
console.log(
  `Route A — evolving an AiProfile (parallel + successive halving)\n` +
    `  pop=${POP} gens=${GENS} matches/finalist=${MATCHES} field=${FIELD} ` +
    `workers=${WORKERS}\n` +
    `  arena=${CONFIG.size}/${CONFIG.map} reference=${CONFIG.difficulty}\n` +
    `  rungs=${RUNGS.map((r) => `${r.matches}m→keep${r.keep}`).join(", ")}\n`,
);

const base = baselineProfile(CONFIG);
console.log("baseline (reference) profile:", JSON.stringify(base), "\n");

const pool = new MatchPool(WORKERS);

let population: AiProfile[] = [structuredClone(base)];
while (population.length < POP) population.push(randomizeFrom(base));

const logRows: string[] = ["gen,bestAvg,bestWins,meanAvg,refAvg,refWins,matchesRun"];
let best: { g: AiProfile; avg: number; wins: number } | null = null;
const t0 = Date.now();

for (let gen = 0; gen < GENS; gen++) {
  const { all, survivors, refAvg, refWins } = await runGeneration(pool, population, base, gen * 1_000_003);

  const top = survivors[0]; // best full-budget finalist
  const mean = all.reduce((s, x) => s + avgOf(x), 0) / all.length;
  if (!best || avgOf(top) > best.avg) best = { g: structuredClone(top.g), avg: avgOf(top), wins: top.wins };

  console.log(
    `gen ${String(gen).padStart(2)}  best=${avgOf(top).toFixed(3)} ` +
      `(wins ${top.wins}/${top.played})  mean=${mean.toFixed(3)}  ` +
      `ref=${refAvg.toFixed(3)} (wins ${refWins}/${MATCHES})  ` +
      `[${matchesRun} matches, ${((Date.now() - t0) / 1000).toFixed(0)}s]`,
  );
  logRows.push(
    `${gen},${avgOf(top).toFixed(4)},${top.wins},${mean.toFixed(4)},${refAvg.toFixed(4)},${refWins},${matchesRun}`,
  );

  // breed next generation: elites (full-budget survivors) verbatim, rest bred
  const elites = survivors.slice(0, ELITE).map((s) => structuredClone(s.g));
  const pick = (): AiProfile => {
    const a = all[Math.floor(rng() * all.length)];
    const b = all[Math.floor(rng() * all.length)];
    return (avgOf(a) >= avgOf(b) ? a : b).g;
  };
  const next: AiProfile[] = [...elites];
  while (next.length < POP) next.push(mutate(crossover(pick(), pick())));
  population = next;
}

// ---- final validation on UNSEEN seeds ---------------------------------------
const valEvals: Eval[] = [];
for (let i = 0; i < 60; i++) valEvals.push({ seed: 7_000_000 + i * 104729 + 1, slot: i % FIELD });
const [evolvedVal, refVal] = await evalSet(pool, [best!.g, base], valEvals);

console.log("\n==== validation (60 unseen matches vs the stock field) ====");
console.log(`evolved : avg=${(evolvedVal.score / 60).toFixed(3)}  wins=${evolvedVal.wins}/60  (${((100 * evolvedVal.wins) / 60).toFixed(0)}%)`);
console.log(`baseline: avg=${(refVal.score / 60).toFixed(3)}  wins=${refVal.wins}/60  (${((100 * refVal.wins) / 60).toFixed(0)}%)`);
console.log(`\n(A lone bot among ${FIELD} equal players wins ~${(100 / FIELD).toFixed(0)}% by chance.)`);
console.log(`total matches simulated: ${matchesRun} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

writeFileSync("train/out/best-profile.json", JSON.stringify(best!.g, null, 2));
writeFileSync("train/out/evolve-log.csv", logRows.join("\n") + "\n");
console.log("\nwrote train/out/best-profile.json");
console.log("wrote train/out/evolve-log.csv");
console.log("best genome:", JSON.stringify(best!.g));

await pool.close();
