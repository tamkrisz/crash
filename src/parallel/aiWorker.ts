/// <reference lib="webworker" />
// Persistent AI steering worker. Parks (zero CPU) on the control generation
// counter between think passes; when the main thread bumps it, this worker plans
// its static stripe of the shared due-list, then atomically reports done. It only
// computes STEERING (writes pdir/aiCooldown into the shared SoA) — shooting/sprint
// stay on the main thread. See coordinator.ts for the other half of the barrier.

import { CTRL } from "./layout";
import { viewWorld, type WorldSabs } from "./worldbuf";
import { makeScratch, planSlice, type SteerScratch, type SteerWorld } from "../ai/steer";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface InitMsg {
  type: "init";
  sabs: WorldSabs;
  control: SharedArrayBuffer;
  cols: number;
  rows: number;
  n: number;
  index: number; // this worker's id, 0..count-1
  count: number; // total workers
}

let world: SteerWorld;
let dueList: Int32Array;
let scratch: SteerScratch;
let ctrl: Int32Array;
let myIndex = 0;
let myCount = 1;

ctx.onmessage = (ev: MessageEvent<InitMsg>) => {
  const msg = ev.data;
  if (msg.type !== "init") return;
  const built = viewWorld(msg.sabs, msg.cols, msg.rows, msg.n);
  world = built.world;
  dueList = built.dueList;
  scratch = makeScratch(msg.cols, msg.rows);
  ctrl = new Int32Array(msg.control);
  myIndex = msg.index;
  myCount = msg.count;
  runLoop();
};

function runLoop(): void {
  // Announce readiness so the coordinator knows every worker is parked before it
  // dispatches the first pass (dispatching too early would deadlock the join).
  ctx.postMessage({ type: "ready" });
  // Start parked at the current generation so we don't run pass 0 before the main
  // thread has populated any due-list.
  let seenGen = Atomics.load(ctrl, CTRL.GENERATION);
  for (;;) {
    Atomics.wait(ctrl, CTRL.GENERATION, seenGen); // zero-CPU park until bumped
    const gen = Atomics.load(ctrl, CTRL.GENERATION);
    if (gen === seenGen) continue; // stale/spurious wake
    seenGen = gen;

    if (Atomics.load(ctrl, CTRL.STOP) === 1) return; // shutdown

    const due = Atomics.load(ctrl, CTRL.DUE_COUNT);
    // static striping: indices myIndex, myIndex+count, myIndex+2*count, ...
    planSlice(world, scratch, dueList, myIndex, due, myCount);

    // report done; the worker that drives PENDING to 0 notifies (harmless if the
    // main thread is spin-waiting on Atomics.load instead).
    const remaining = Atomics.sub(ctrl, CTRL.PENDING, 1) - 1;
    if (remaining === 0) Atomics.notify(ctrl, CTRL.PENDING);
  }
}
