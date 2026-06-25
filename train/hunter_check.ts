// Hunter behaviour probe — isolates the two failures we care about by choosing
// fields where each is the ONLY thing that can happen:
//
//   LONE hunter (1 cycle): there is no rival to kill it, so the round ends ONLY
//     when it kills ITSELF (drives into its own trail/a wall, or its own blast).
//     => survivalRate (survived to the step cap) should be ~1.0; any death is a
//        pure self-kill. This is "the hunter still kills itself".
//
//   DUEL (2 hunters): the round ends when the first one dies. That death is
//     either a mutual kill (the other's blast: kills==1) or a self-kill (kills==0).
//     => mutualKillRate should be ~0 ("two hunters shouldn't kill each other"),
//        and ideally BOTH survive to the cap (bothSurvive) — a true stand-off.
//
//   MELEE (N hunters): a bounded free-for-all must end with N-1 deaths, so total
//     deaths is structural; we report avgSteps (how long they last) as a coarse
//     self-preservation signal.
//
// Build & run:
//   node_modules/.bin/esbuild train/hunter_check.ts --bundle --format=esm \
//     --platform=node --outdir=train/out --entry-names=hunter_check
//   node train/out/hunter_check.js

import { runMatch } from "./headless";
import type { MatchConfig, AiRoster, Difficulty, MapSize } from "../src/types";

const allHunters: AiRoster = { mode: "uniform", personality: "hunter", counts: {}, pool: [] };
const SURVIVED = Number.MAX_SAFE_INTEGER;
const MATCHES = Number(process.env.MATCHES ?? 120);
const STEP_CAP = Number(process.env.STEP_CAP ?? 4000);

function cfg(ai: number, size: MapSize, difficulty: Difficulty, map: string): MatchConfig {
  return { humans: 0, ai, speed: "normal", difficulty, map, size, mode: "classic", roster: allHunters };
}

function lone(label: string, config: MatchConfig) {
  let survived = 0, steps = 0;
  for (let seed = 1; seed <= MATCHES; seed++) {
    const r = runMatch({ config, seed, profiles: {}, stepCap: STEP_CAP });
    if (r.diedAt[0] === SURVIVED) survived++;
    steps += r.steps;
  }
  console.log(
    `${label}\n  survivalRate=${(100 * survived / MATCHES).toFixed(0)}%  ` +
      `avgSteps=${(steps / MATCHES).toFixed(0)}  (deaths here are pure self-kills)\n`,
  );
}

function duel(label: string, config: MatchConfig) {
  let mutual = 0, suicide = 0, bothSurvive = 0, steps = 0;
  for (let seed = 1; seed <= MATCHES; seed++) {
    const r = runMatch({ config, seed, profiles: {}, stepCap: STEP_CAP });
    const died = r.diedAt.filter((d) => d !== SURVIVED).length;
    const killed = r.kills.reduce((a, b) => a + b, 0);
    if (died === 0) bothSurvive++;
    else { mutual += killed; suicide += Math.max(0, died - killed); }
    steps += r.steps;
  }
  console.log(
    `${label}\n  bothSurvive=${(100 * bothSurvive / MATCHES).toFixed(0)}%  ` +
      `mutualKillRate=${(100 * mutual / MATCHES).toFixed(0)}%  ` +
      `selfKillRate=${(100 * suicide / MATCHES).toFixed(0)}%  ` +
      `avgSteps=${(steps / MATCHES).toFixed(0)}\n`,
  );
}

function melee(label: string, config: MatchConfig) {
  let steps = 0, suicide = 0, mutual = 0;
  for (let seed = 1; seed <= MATCHES; seed++) {
    const r = runMatch({ config, seed, profiles: {}, stepCap: STEP_CAP });
    const died = r.diedAt.filter((d) => d !== SURVIVED).length;
    const killed = r.kills.reduce((a, b) => a + b, 0);
    mutual += killed; suicide += Math.max(0, died - killed); steps += r.steps;
  }
  console.log(
    `${label}\n  avgSteps=${(steps / MATCHES).toFixed(0)}  ` +
      `selfKills/match=${(suicide / MATCHES).toFixed(2)}  ` +
      `mutualKills/match=${(mutual / MATCHES).toFixed(2)}\n`,
  );
}

console.log(`(${MATCHES} matches each, stepCap ${STEP_CAP})\n`);
lone("LONE  · medium · hard · boxes", cfg(1, "medium", "hard", "boxes"));
lone("LONE  · small  · cheating · cross", cfg(1, "small", "cheating", "cross"));
duel("DUEL  · medium · hard · boxes", cfg(2, "medium", "hard", "boxes"));
duel("DUEL  · small  · cheating · cross", cfg(2, "small", "cheating", "cross"));
melee("MELEE · medium · hard · boxes (6)", cfg(6, "medium", "hard", "boxes"));
