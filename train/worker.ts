// Worker thread: runs headless matches on demand. Each worker owns its OWN Game
// (runMatch reuses one Game per module instance) and reseeds the global
// Math.random per match, so workers are fully isolated — no shared state, no
// SharedArrayBuffer. The main thread (pool.ts) feeds jobs and collects replies.

import { parentPort } from "node:worker_threads";
import { runMatch } from "./headless";
import type { MatchConfig, AiProfile } from "../src/types";

export interface MatchJob {
  id: number; // index into the batch, echoed back so the pool can re-align results
  config: MatchConfig;
  seed: number;
  // profiles to inject by slot. For vs-reference training that's just the one
  // candidate slot; for self-play it's the candidate PLUS its opponents' profiles.
  // Slots left out keep whatever the config's difficulty/roster built.
  profiles: Record<number, AiProfile>;
  scoredSlot: number; // which slot's outcome we report back
  stepCap: number;
}

export interface MatchReply {
  id: number;
  slot: number;
  winnerSlot: number | null;
  diedAt: number[];
  kills: number[];
  length: number[]; // trail length per slot — territory tiebreak for draws
  nSlots: number;
}

if (!parentPort) throw new Error("worker.ts must run inside a worker_thread");

parentPort.on("message", (job: MatchJob) => {
  const r = runMatch({
    config: job.config,
    seed: job.seed,
    profiles: job.profiles,
    stepCap: job.stepCap,
  });
  const reply: MatchReply = {
    id: job.id,
    slot: job.scoredSlot,
    winnerSlot: r.winnerSlot,
    diedAt: r.diedAt,
    kills: r.kills,
    length: r.length,
    nSlots: r.nSlots,
  };
  parentPort!.postMessage(reply);
});
