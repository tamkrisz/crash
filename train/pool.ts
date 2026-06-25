// A persistent pool of worker threads that run whole matches in parallel. Matches
// are independent CPU work, so spreading them across cores gives near-linear
// speedup. Workers are spawned once and reused for the entire training run.
//
// The worker file path is derived from import.meta.url with node:url/path (NOT the
// `new Worker(new URL(...))` literal) so esbuild doesn't try to re-bundle worker.js
// as a side chunk — we bundle it ourselves as its own entry point.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchJob, MatchReply } from "./worker";

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "worker.js");

export class MatchPool {
  private workers: Worker[];
  readonly size: number;

  constructor(n: number) {
    this.size = Math.max(1, n);
    this.workers = Array.from({ length: this.size }, () => new Worker(WORKER_FILE));
  }

  // Run a batch of matches across all workers. Resolves with replies aligned to
  // the input order: the reply for jobs[i] is at results[i]. A free worker is
  // immediately handed the next pending job, so load stays balanced even when
  // matches vary wildly in length (early crash vs long survival duel).
  run(jobs: Omit<MatchJob, "id">[]): Promise<MatchReply[]> {
    return new Promise((resolve, reject) => {
      const results = new Array<MatchReply>(jobs.length);
      if (jobs.length === 0) return resolve(results);

      let next = 0;
      let done = 0;
      const feed = (w: Worker) => {
        if (next >= jobs.length) return;
        const id = next++;
        w.postMessage({ ...jobs[id], id });
      };

      for (const w of this.workers) {
        w.removeAllListeners("message");
        w.removeAllListeners("error");
        w.on("message", (res: MatchReply) => {
          results[res.id] = res;
          if (++done === jobs.length) resolve(results);
          else feed(w);
        });
        w.on("error", reject);
      }
      for (const w of this.workers) feed(w);
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
