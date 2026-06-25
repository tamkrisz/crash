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
  run(jobs2) {
    return new Promise((resolve, reject) => {
      const results = new Array(jobs2.length);
      if (jobs2.length === 0) return resolve(results);
      let next = 0;
      let done = 0;
      const feed = (w) => {
        if (next >= jobs2.length) return;
        const id = next++;
        w.postMessage({ ...jobs2[id], id });
      };
      for (const w of this.workers) {
        w.removeAllListeners("message");
        w.removeAllListeners("error");
        w.on("message", (res) => {
          results[res.id] = res;
          if (++done === jobs2.length) resolve(results);
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

// train/eval.ts
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
var PROFILE = process.env.PROFILE ?? "train/out/selfplay-best.json";
var MATCHES = Number(process.env.MATCHES ?? 200);
var FIELD = Number(process.env.FIELD ?? 4);
var SIZE = process.env.SIZE ?? "small";
var STEP_CAP = Number(process.env.STEP_CAP ?? 2500);
var WORKERS = Number(process.env.WORKERS ?? cpus().length);
var DIFFICULTY = process.env.DIFFICULTY ?? "cheating";
var ROSTER = process.env.ROSTER ?? "random";
var MODE = process.env.MODE ?? "classic";
var LABEL = process.env.LABEL ?? PROFILE;
function roster() {
  if (ROSTER.startsWith("uniform:"))
    return { mode: "uniform", personality: ROSTER.slice(8), counts: {}, pool: [] };
  if (ROSTER === "random") return { mode: "random", personality: "balanced", counts: {}, pool: [] };
  return { mode: "uniform", personality: "balanced", counts: {}, pool: [] };
}
var CONFIG = {
  humans: 0,
  ai: FIELD,
  speed: "normal",
  difficulty: DIFFICULTY,
  map: "cross",
  size: SIZE,
  mode: MODE,
  roster: roster()
};
var profile = JSON.parse(readFileSync(PROFILE, "utf8"));
var pool = new MatchPool(WORKERS);
var jobs = [];
for (let i = 0; i < MATCHES; i++) {
  const slot = i % FIELD;
  jobs.push({ config: CONFIG, seed: 5e6 + i * 104729 + 1, scoredSlot: slot, profiles: { [slot]: profile }, stepCap: STEP_CAP });
}
var replies = await pool.run(jobs);
var wins = 0;
var placeSum = 0;
var draws = 0;
var killSum = 0;
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
console.log(`  WIN RATE: ${wins}/${MATCHES} = ${(100 * wins / MATCHES).toFixed(1)}%   (draws ${draws})`);
console.log(`  avg placement: ${(placeSum / MATCHES).toFixed(3)}  (1.0 = outlived the whole field)`);
console.log(`  avg KILLS: ${(killSum / MATCHES).toFixed(2)} per match`);
await pool.close();
