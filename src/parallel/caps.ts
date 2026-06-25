// Runtime detection of whether parallel (SharedArrayBuffer + Atomics) AI is
// available. Requires the page to be cross-origin isolated (COOP/COEP headers —
// see vite.config.ts and the deploy note there). When unavailable, the caller
// falls back to the single-threaded path; nothing breaks, it just isn't parallel.

export interface ParallelCaps {
  available: boolean;
  workerCount: number; // 0 when unavailable
  reason: string;
}

export function detectParallel(): ParallelCaps {
  if (typeof SharedArrayBuffer === "undefined")
    return { available: false, workerCount: 0, reason: "SharedArrayBuffer undefined" };
  // crossOriginIsolated is the authoritative gate for shared memory + Atomics.wait.
  if (typeof self !== "undefined" && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated !== true)
    return { available: false, workerCount: 0, reason: "not crossOriginIsolated (COOP/COEP headers missing)" };
  if (typeof Worker === "undefined")
    return { available: false, workerCount: 0, reason: "Worker unavailable" };

  const cores = navigator.hardwareConcurrency || 4;
  // leave one core for the main thread + compositor; never below 1
  return { available: true, workerCount: Math.max(1, cores - 1), reason: "ok" };
}
