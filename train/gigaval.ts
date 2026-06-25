// Definitive giga kill comparison. Kills are noisy, so we need a big sample:
// each match seats COPIES of every contender (in shuffled slots) plus prey, and
// we average kills over K matches => K*COPIES samples per contender. Used to pick
// the real Hunter+ champion and confirm it actually out-kills the stock hunter.

import { MatchPool } from "./pool";
import { baselineProfile } from "./headless";
import type { MatchReply } from "./worker";
import type { AiProfile, MatchConfig, Personality } from "../src/types";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

const K = Number(process.env.K ?? 60);
const COPIES = Number(process.env.COPIES ?? 16);
const STEP_CAP = Number(process.env.STEP_CAP ?? 4500);
const PREY_DIFF = (process.env.PREY_DIFF ?? "hard") as MatchConfig["difficulty"];
const WORKERS = Number(process.env.WORKERS ?? cpus().length);
const SLOTS = 128;

const CONFIG: MatchConfig = {
  humans: 0, ai: SLOTS, speed: "normal", difficulty: "cheating",
  map: "cross", size: "large", mode: "giga",
  roster: { mode: "uniform", personality: "balanced", counts: {}, pool: [] },
};
const profFor = (difficulty: MatchConfig["difficulty"], personality: Personality): AiProfile =>
  baselineProfile({ ...CONFIG, difficulty, mode: "classic", size: "small",
    roster: { mode: "uniform", personality, counts: {}, pool: [] } });

// contenders to rank (label -> profile). PROFILES env = comma-separated json paths.
const extra = (process.env.PROFILES ?? "train/out/hunterplus-best.json").split(",").filter(Boolean);
const contenders: { label: string; prof: AiProfile }[] = [
  { label: "stock cheating-hunter", prof: profFor("cheating", "hunter") },
  ...extra.map((p) => ({ label: p.split("/").pop()!, prof: JSON.parse(readFileSync(p, "utf8")) as AiProfile })),
];
const prey = (["balanced", "packer", "runner", "roamer", "ambusher"] as Personality[]).map((p) => profFor(PREY_DIFF, p));

function shuffled(n: number, seed: number): number[] {
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const pool = new MatchPool(WORKERS);
const C = contenders.length;
const need = C * COPIES;
if (need > SLOTS) throw new Error(`${C} contenders x ${COPIES} copies = ${need} > ${SLOTS} slots`);

const jobs: any[] = [];
const maps: number[][][] = []; // per match: contender -> its slots
for (let k = 0; k < K; k++) {
  const order = shuffled(SLOTS, 0xabc123 ^ (k * 2654435761));
  const profiles: Record<number, AiProfile> = {};
  const slotsByContender: number[][] = contenders.map(() => []);
  let p = 0;
  for (let c = 0; c < C; c++) for (let j = 0; j < COPIES; j++) { const sl = order[p++]; profiles[sl] = contenders[c].prof; slotsByContender[c].push(sl); }
  for (; p < SLOTS; p++) profiles[order[p]] = prey[p % prey.length];
  jobs.push({ config: CONFIG, seed: 6_000_000 + k * 104729 + 1, scoredSlot: order[0], profiles, stepCap: STEP_CAP });
  maps.push(slotsByContender);
}

const replies: MatchReply[] = await pool.run(jobs);
const sum = contenders.map(() => 0);
const samples = K * COPIES;
for (let k = 0; k < replies.length; k++)
  for (let c = 0; c < C; c++)
    for (const sl of maps[k][c]) sum[c] += replies[k].kills[sl];

console.log(`Giga kill gauntlet — ${K} matches x ${COPIES} copies = ${samples} samples each, prey=${PREY_DIFF}, stepCap=${STEP_CAP}\n`);
const ranked = contenders.map((c, i) => ({ label: c.label, kills: sum[i] / samples })).sort((a, b) => b.kills - a.kills);
for (const r of ranked) console.log(`  ${r.kills.toFixed(3)} kills/match   ${r.label}`);

await pool.close();
