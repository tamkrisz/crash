// Evaluate ONE profile against a configurable field, in parallel. Used to answer
// "how does the trained bot do vs <X>?" — e.g. vs a field of MIXED cheating
// characters (random personalities at cheating difficulty).
//
//   PROFILE=train/out/selfplay-best.json DIFFICULTY=cheating ROSTER=random \
//   FIELD=4 MATCHES=200 node train/out/eval.js
//
// ROSTER: "random" (mixed characters), "uniform:<persona>" (all one character),
// or "balanced". The profile is injected into one (rotating) slot; the rest are
// stock bots built from DIFFICULTY + ROSTER.

import { MatchPool } from "./pool";
import type { AiProfile, MatchConfig, Personality } from "../src/types";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

const PROFILE = process.env.PROFILE ?? "train/out/selfplay-best.json";
const MATCHES = Number(process.env.MATCHES ?? 200);
const FIELD = Number(process.env.FIELD ?? 4);
const SIZE = (process.env.SIZE ?? "small") as MatchConfig["size"];
const STEP_CAP = Number(process.env.STEP_CAP ?? 2500);
const WORKERS = Number(process.env.WORKERS ?? cpus().length);
const DIFFICULTY = (process.env.DIFFICULTY ?? "cheating") as MatchConfig["difficulty"];
const ROSTER = process.env.ROSTER ?? "random";
const MODE = (process.env.MODE ?? "classic") as NonNullable<MatchConfig["mode"]>;
const LABEL = process.env.LABEL ?? PROFILE;

function roster(): MatchConfig["roster"] {
  if (ROSTER.startsWith("uniform:"))
    return { mode: "uniform", personality: ROSTER.slice(8) as Personality, counts: {}, pool: [] };
  if (ROSTER === "random") return { mode: "random", personality: "balanced", counts: {}, pool: [] };
  return { mode: "uniform", personality: "balanced", counts: {}, pool: [] };
}
const CONFIG: MatchConfig = {
  humans: 0, ai: FIELD, speed: "normal", difficulty: DIFFICULTY,
  map: "cross", size: SIZE, mode: MODE, roster: roster(),
};

const profile: AiProfile = JSON.parse(readFileSync(PROFILE, "utf8"));
const pool = new MatchPool(WORKERS);

const jobs = [];
for (let i = 0; i < MATCHES; i++) {
  const slot = i % FIELD;
  jobs.push({ config: CONFIG, seed: 5_000_000 + i * 104729 + 1, scoredSlot: slot, profiles: { [slot]: profile }, stepCap: STEP_CAP });
}
const replies = await pool.run(jobs);

let wins = 0, placeSum = 0, draws = 0, killSum = 0;
for (const r of replies) {
  const slot = r.slot, myDeath = r.diedAt[slot];
  let outlived = 0;
  for (let i = 0; i < r.nSlots; i++) if (i !== slot && r.diedAt[i] < myDeath) outlived++;
  placeSum += outlived / Math.max(1, r.nSlots - 1);
  killSum += r.kills[slot];
  if (r.winnerSlot === slot) wins++;
  else if (r.winnerSlot === null) draws++;
}

console.log(`${LABEL}`);
console.log(`  field: ${DIFFICULTY} / roster=${ROSTER} / mode=${MODE} / FIELD=${FIELD} / size=${SIZE} / ${MATCHES} matches`);
console.log(`  WIN RATE: ${wins}/${MATCHES} = ${((100 * wins) / MATCHES).toFixed(1)}%   (draws ${draws})`);
console.log(`  avg placement: ${(placeSum / MATCHES).toFixed(3)}  (1.0 = outlived the whole field)`);
console.log(`  avg KILLS: ${(killSum / MATCHES).toFixed(2)} per match`);

await pool.close();
