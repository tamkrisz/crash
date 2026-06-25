// Smoke test: run a handful of headless matches with the stock difficulty bots
// and print the outcomes. If this prints winners and varied step counts, the
// headless harness is faithfully driving the real Game with zero source changes.

import { runMatch, baselineProfile } from "./headless";
import type { MatchConfig } from "../src/types";

const config: MatchConfig = {
  humans: 0,
  ai: 4,
  speed: "normal",
  difficulty: "hard",
  map: "cross",
  size: "small",
  mode: "classic",
};

console.log("baseline 'hard'/balanced profile:");
console.log(JSON.stringify(baselineProfile(config), null, 0));
console.log("");

let t0 = Date.now();
let matches = 0;
for (let seed = 1; seed <= 8; seed++) {
  const r = runMatch({ config, seed, profiles: {} });
  matches++;
  console.log(
    `seed ${seed}: winner=slot ${r.winnerSlot ?? "DRAW"}  steps=${r.steps}  ` +
      `diedAt=[${r.diedAt.map((d) => (d > 1e9 ? "—" : d)).join(",")}]  ` +
      `kills=[${r.kills.join(",")}]`,
  );
}
const ms = Date.now() - t0;
console.log(`\n${matches} matches in ${ms}ms  (${(ms / matches).toFixed(1)} ms/match)`);
