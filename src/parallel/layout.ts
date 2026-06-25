// Control SharedArrayBuffer layout for the per-frame fork/join barrier.
// A tiny Int32Array the main thread and workers coordinate through with Atomics.

export const CTRL = {
  GENERATION: 0, // bumped by main each think pass; workers park on it changing
  PENDING: 1, // workers still owing completion this pass (main spins to 0)
  DUE_COUNT: 2, // number of valid entries in the shared dueList this pass
  STOP: 3, // set to 1 to tell parked workers to exit their loop
  LEN: 4, // total Int32 slots
} as const;

export function makeControlSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(CTRL.LEN * Int32Array.BYTES_PER_ELEMENT);
}
