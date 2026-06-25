// Hunter+ : evolve a killer for GIGA mode (128 cycles) whose fitness is purely
// KILLS — "kill as many as possible". Seeded from the cheating HUNTER profile.
//
// Giga matches are expensive (128 bots, 880x640), so we use the multi-candidate
// trick: ONE giga match returns the kill count for ALL 128 slots, so a single
// match evaluates the entire population at once. Each generation runs only K giga
// matches (different seeds + shuffled slot placement); the rest of the 128 slots
// are filled with cheaper evasive PREY (cheating non-hunters — they have no
// pathfinding, which is what makes a full hunter field cost ~20x more).
//
// Output: train/out/hunterplus-best.json.

import { baselineProfile } from "./headless";
import { MatchPool } from "./pool";
import type { MatchReply } from "./worker";
import type { AiProfile, MatchConfig, Personality } from "../src/types";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";

const POP = Number(process.env.POP ?? 32);
const GENS = Number(process.env.GENS ?? 30);
const K = Number(process.env.K ?? 8); // giga matches (seeds) per generation
const ELITE = Number(process.env.ELITE ?? 5);
const STEP_CAP = Number(process.env.STEP_CAP ?? 4000);
const GA_SEED = Number(process.env.SEED ?? 7777);
const WORKERS = Number(process.env.WORKERS ?? cpus().length);
const PREY_DIFF = (process.env.PREY_DIFF ?? "hard") as MatchConfig["difficulty"];
const SLOTS = 128; // giga = 4 quadrants x 32

const CONFIG: MatchConfig = {
  humans: 0, ai: SLOTS, speed: "normal", difficulty: "cheating",
  map: "cross", size: "large", mode: "giga",
  roster: { mode: "uniform", personality: "balanced", counts: {}, pool: [] },
};

// ---- PRNGs ------------------------------------------------------------------
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
// deterministic Fisher-Yates over [0..n) seeded by `seed` (slot placement)
function shuffledSlots(n: number, seed: number): number[] {
  const r = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- genome (same spec as the other trainers) -------------------------------
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
// pacifist is excluded — a killer never refuses to attack. The rest of the hunter
// toolkit (stalk/breach/pathfind/dodge/sprint) is fair game and starts ON.
const BOOL_GENES: (keyof AiProfile)[] = ["alwaysSprint", "stalk", "breach", "pathfind", "dodge"];
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function randomizeFrom(base: AiProfile): AiProfile {
  const g = structuredClone(base);
  g.lead = true; g.escape = true; g.pacifist = false;
  g.seekRange = base.seekRange ?? base.aimRange;
  for (const gene of NUM_GENES) {
    let v = ((g[gene.key] as number) ?? 0) + gauss() * gene.sigma;
    (g[gene.key] as number) = gene.int ? Math.round(clamp(v, gene.min, gene.max)) : clamp(v, gene.min, gene.max);
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
    const v = (c[gene.key] as number) + gauss() * gene.sigma * 0.6;
    (c[gene.key] as number) = gene.int ? Math.round(clamp(v, gene.min, gene.max)) : clamp(v, gene.min, gene.max);
  }
  for (const b of BOOL_GENES) if (rng() < 0.08) (c[b] as boolean) = !(c[b] as boolean);
  c.pacifist = false;
  return c;
}
function crossover(a: AiProfile, b: AiProfile): AiProfile {
  const c = structuredClone(a);
  for (const gene of NUM_GENES) if (rng() < 0.5) (c[gene.key] as number) = b[gene.key] as number;
  for (const x of BOOL_GENES) if (rng() < 0.5) (c[x] as boolean) = b[x] as boolean;
  return c;
}

// ---- prey: a rotating set of cheating non-hunters (cheap, evasive, varied) ---
const PREY_PERSONAS: Personality[] = ["balanced", "packer", "runner", "roamer", "ambusher"];
function preyProfile(p: Personality): AiProfile {
  return baselineProfile({ ...CONFIG, difficulty: PREY_DIFF, mode: "classic", size: "small",
    roster: { mode: "uniform", personality: p, counts: {}, pool: [] } });
}
const PREY = PREY_PERSONAS.map(preyProfile);

// ---- evaluation: K giga matches, read kills for every candidate slot ---------
let matchesRun = 0;
async function evalPop(pool: MatchPool, pop: AiProfile[], genBase: number): Promise<number[]> {
  const kills = new Array(pop.length).fill(0);
  const placement = new Array(pop.length).fill(0);
  const jobs: any[] = [];
  const slotMaps: number[][] = []; // per match: candidateIndex -> slot
  for (let k = 0; k < K; k++) {
    const seed = genBase + k * 911 + 1;
    const order = shuffledSlots(SLOTS, seed ^ 0x9e3779b9); // which slots are candidates
    const candSlots = order.slice(0, pop.length);
    const profiles: Record<number, AiProfile> = {};
    for (let i = 0; i < pop.length; i++) profiles[candSlots[i]] = pop[i];
    for (let s = pop.length; s < SLOTS; s++) profiles[order[s]] = PREY[s % PREY.length];
    jobs.push({ config: CONFIG, seed, scoredSlot: candSlots[0], profiles, stepCap: STEP_CAP });
    slotMaps.push(candSlots);
  }
  const replies: MatchReply[] = await pool.run(jobs);
  matchesRun += jobs.length;
  for (let k = 0; k < replies.length; k++) {
    const r = replies[k], cand = slotMaps[k];
    for (let i = 0; i < pop.length; i++) {
      kills[i] += r.kills[cand[i]];
      // tiny survival tiebreak so 0-kill genomes still have a gradient early on
      const myDeath = r.diedAt[cand[i]];
      let outlived = 0;
      for (let s = 0; s < r.nSlots; s++) if (s !== cand[i] && r.diedAt[s] < myDeath) outlived++;
      placement[i] += outlived / (r.nSlots - 1);
    }
  }
  return pop.map((_, i) => kills[i] / K + (placement[i] / K) * 0.1);
}

// ---- run --------------------------------------------------------------------
const hunterSeed = baselineProfile({ ...CONFIG, mode: "classic", size: "small",
  roster: { mode: "uniform", personality: "hunter", counts: {}, pool: [] } });
console.log(
  `Hunter+ — evolving a GIGA killer (fitness = kills)\n` +
    `  pop=${POP} gens=${GENS} matches/gen=${K} slots=${SLOTS} workers=${WORKERS} stepCap=${STEP_CAP}\n` +
    `  seed = cheating HUNTER: ${JSON.stringify(hunterSeed)}\n` +
    `  prey = ${PREY_DIFF} ${PREY_PERSONAS.join("/")}\n`,
);

const pool = new MatchPool(WORKERS);
let population: AiProfile[] = [structuredClone(hunterSeed)];
while (population.length < POP) population.push(randomizeFrom(hunterSeed));

// yardstick: the stock cheating hunter's kill rate is constant, so measure it ONCE
// (recomputing every generation would double the match count for no new info).
const seedFit = (await evalPop(pool, [hunterSeed], 12_345_000))[0];
console.log(`stock cheating-hunter baseline: ${seedFit.toFixed(2)} kills/match\n`);

const logRows = ["gen,bestKills,meanKills,seedKills,matchesRun"];
let best: { g: AiProfile; fit: number } | null = null;
const t0 = Date.now();

for (let gen = 0; gen < GENS; gen++) {
  const fits = await evalPop(pool, population, gen * 1_000_003);
  const idx = fits.map((f, i) => i).sort((a, b) => fits[b] - fits[a]);
  const top = idx[0];
  const mean = fits.reduce((s, x) => s + x, 0) / fits.length;
  if (!best || fits[top] > best.fit) best = { g: structuredClone(population[top]), fit: fits[top] };

  console.log(
    `gen ${String(gen).padStart(2)}  best=${fits[top].toFixed(2)} kills  mean=${mean.toFixed(2)}  ` +
      `stockHunter=${seedFit.toFixed(2)}  [${matchesRun} matches, ${((Date.now() - t0) / 1000).toFixed(0)}s]`,
  );
  logRows.push(`${gen},${fits[top].toFixed(3)},${mean.toFixed(3)},${seedFit.toFixed(3)},${matchesRun}`);

  const elites = idx.slice(0, ELITE).map((i) => structuredClone(population[i]));
  const pick = (): AiProfile => {
    const a = Math.floor(rng() * POP), b = Math.floor(rng() * POP);
    return population[fits[a] >= fits[b] ? a : b];
  };
  const next: AiProfile[] = [...elites];
  while (next.length < POP) next.push(mutate(crossover(pick(), pick())));
  population = next;
}

// ---- final report -----------------------------------------------------------
const finalFit = (await evalPop(pool, [best!.g], 5_555_000))[0];
const stockFinal = (await evalPop(pool, [hunterSeed], 5_555_000))[0];
console.log(`\n==== Hunter+ final (avg kills/match in giga, ${K} unseen matches) ====`);
console.log(`Hunter+ champion : ${finalFit.toFixed(2)} kills/match`);
console.log(`stock cheating hunter: ${stockFinal.toFixed(2)} kills/match`);
console.log(`total matches simulated: ${matchesRun} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

writeFileSync("train/out/hunterplus-best.json", JSON.stringify(best!.g, null, 2));
writeFileSync("train/out/hunterplus-log.csv", logRows.join("\n") + "\n");
console.log("\nwrote train/out/hunterplus-best.json");
console.log("champion:", JSON.stringify(best!.g));

await pool.close();
