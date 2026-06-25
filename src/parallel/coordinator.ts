// Main-thread coordinator for the parallel AI think phase. Owns a persistent pool
// of workers and the shared world buffers, and drives a per-frame fork/join:
// populate the due-list -> wake workers -> spin-wait (Atomics.load, since the main
// thread may not Atomics.wait) -> results are in the shared SoA. See aiWorker.ts.

import { CTRL, makeControlSab } from "./layout";
import { allocWorldSabs, viewWorld, type WorldSabs } from "./worldbuf";
import type { SteerWorld } from "../ai/steer";

// Hard cap on the join spin so a crashed/hung worker degrades to a dropped frame
// of planning (bots coast on last heading) instead of freezing the tab. The spin
// is a MAIN-THREAD busy-wait, so this value is the worst-case stall a stuck worker
// can inflict: at 250ms that was a visible ~15-frame freeze. One frame at 60fps
// (~16ms) keeps the hiccup invisible — the normal join finishes in well under this,
// so it only ever bites on an actual hang. Tuning knob: very large fields whose
// legitimate think pass exceeds a frame may raise this (they're already below 60fps,
// and the alternative is coasting that pass) — but never back to a perceptible stall.
const SPIN_TIMEOUT_MS = 16;

export class ParallelAi {
  readonly workerCount: number;
  private workers: Worker[] = [];
  private control: Int32Array;
  private controlSab: SharedArrayBuffer;
  private sabs: WorldSabs | null = null;

  private cols = 0;
  private rows = 0;
  private n = 0;
  private readyCount = 0;

  // main-thread views over the shared world (Game writes the snapshot here)
  world: SteerWorld | null = null;
  dueList: Int32Array | null = null;

  constructor(workerCount: number) {
    this.workerCount = workerCount;
    this.controlSab = makeControlSab();
    this.control = new Int32Array(this.controlSab);
  }

  // True once every worker has set up and parked — until then the caller must use
  // the single-threaded path (dispatching before workers park would deadlock).
  isReady(): boolean {
    return this.world !== null && this.readyCount >= this.workerCount;
  }

  matches(cols: number, rows: number, n: number): boolean {
    return this.cols === cols && this.rows === rows && this.n === n;
  }

  // (Re)allocate shared buffers for a new match shape and respawn the worker pool.
  // Matches are infrequent, so a clean teardown/respawn avoids the "re-init a
  // parked worker" problem (a worker blocked in Atomics.wait can't read messages).
  resize(cols: number, rows: number, n: number): void {
    this.dispose();
    this.cols = cols;
    this.rows = rows;
    this.n = n;
    this.readyCount = 0;

    // fresh control buffer each match (old workers are gone)
    this.controlSab = makeControlSab();
    this.control = new Int32Array(this.controlSab);
    Atomics.store(this.control, CTRL.GENERATION, 0);
    Atomics.store(this.control, CTRL.PENDING, 0);
    Atomics.store(this.control, CTRL.DUE_COUNT, 0);
    Atomics.store(this.control, CTRL.STOP, 0);

    this.sabs = allocWorldSabs(cols, rows, n);
    const built = viewWorld(this.sabs, cols, rows, n);
    this.world = built.world;
    this.dueList = built.dueList;

    for (let i = 0; i < this.workerCount; i++) {
      const w = new Worker(new URL("./aiWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<{ type: string }>) => {
        if (ev.data?.type === "ready") this.readyCount++;
      };
      w.postMessage({
        type: "init",
        sabs: this.sabs,
        control: this.controlSab,
        cols,
        rows,
        n,
        index: i,
        count: this.workerCount,
      });
      this.workers.push(w);
    }
  }

  // Run one think pass over dueList[0..dueCount). Caller must have written the
  // due indices into this.dueList and the SoA snapshot into this.world first.
  // Blocks (busy-spin) until every worker reports done. No-op if not ready.
  think(dueCount: number): void {
    if (!this.isReady() || dueCount <= 0) return;
    const ctrl = this.control;
    // arm the join counter BEFORE waking anyone, or a fast worker could decrement
    // a stale PENDING
    Atomics.store(ctrl, CTRL.DUE_COUNT, dueCount);
    Atomics.store(ctrl, CTRL.PENDING, this.workerCount);
    Atomics.add(ctrl, CTRL.GENERATION, 1);
    Atomics.notify(ctrl, CTRL.GENERATION, this.workerCount);

    const deadline = performance.now() + SPIN_TIMEOUT_MS;
    let guard = 0;
    while (Atomics.load(ctrl, CTRL.PENDING) !== 0) {
      // check wall-clock occasionally (performance.now is comparatively costly)
      if ((++guard & 0x3ff) === 0 && performance.now() > deadline) {
        // a worker hung/died — give up on this pass; un-planned bots keep their
        // snapshot heading for one frame (safe). Don't freeze the tab.
        console.warn("[parallel] think join timed out; degrading this frame");
        break;
      }
    }
  }

  dispose(): void {
    if (this.workers.length) {
      Atomics.store(this.control, CTRL.STOP, 1);
      Atomics.add(this.control, CTRL.GENERATION, 1);
      Atomics.notify(this.control, CTRL.GENERATION, this.workerCount);
      for (const w of this.workers) w.terminate();
      this.workers = [];
    }
    this.readyCount = 0;
  }
}
