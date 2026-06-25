// Calibration: how long does a LONE bot of each personality survive, and how
// often do TWO of them stand off without anyone dying? Tells us what's actually
// achievable (so we know whether the hunter's 0% lone survival is a hunter bug or
// just the bounded arena), and isolates hunter-specific regressions.

import { runMatch } from "./headless";
import type { MatchConfig, AiRoster, Personality } from "../src/types";
const SURVIVED = Number.MAX_SAFE_INTEGER;
const MATCHES = Number(process.env.MATCHES ?? 60);
const STEP_CAP = Number(process.env.STEP_CAP ?? 4000);

function roster(personality: Personality): AiRoster {
  return { mode: "uniform", personality, counts: {}, pool: [] };
}
function base(ai: number, personality: Personality): MatchConfig {
  return { humans: 0, ai, speed: "normal", difficulty: "hard", map: "boxes",
    size: "medium", mode: "classic", roster: roster(personality) };
}

const chars: Personality[] = ["balanced", "survivor", "runner", "hunter"];
console.log(`LONE survival (1 bot, medium/boxes/hard, ${MATCHES} matches, cap ${STEP_CAP}):`);
for (const c of chars) {
  let surv = 0, steps = 0;
  for (let seed = 1; seed <= MATCHES; seed++) {
    const r = runMatch({ config: base(1, c), seed, profiles: {}, stepCap: STEP_CAP });
    if (r.diedAt[0] === SURVIVED) surv++;
    steps += r.steps;
  }
  console.log(`  ${c.padEnd(9)} survival=${(100 * surv / MATCHES).toFixed(0)}%  avgSteps=${(steps / MATCHES).toFixed(0)}`);
}
console.log(`\nDUEL (2 bots) bothSurvive / mutualKill / selfKill / avgSteps:`);
for (const c of chars) {
  let both = 0, mutual = 0, self = 0, steps = 0;
  for (let seed = 1; seed <= MATCHES; seed++) {
    const r = runMatch({ config: base(2, c), seed, profiles: {}, stepCap: STEP_CAP });
    const died = r.diedAt.filter((d) => d !== SURVIVED).length;
    const killed = r.kills.reduce((a, b) => a + b, 0);
    if (died === 0) both++; else { mutual += killed; self += Math.max(0, died - killed); }
    steps += r.steps;
  }
  console.log(`  ${c.padEnd(9)} both=${(100*both/MATCHES).toFixed(0)}%  mutual=${(100*mutual/MATCHES).toFixed(0)}%  self=${(100*self/MATCHES).toFixed(0)}%  avgSteps=${(steps/MATCHES).toFixed(0)}`);
}
