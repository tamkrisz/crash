// Allocation + view construction for the SharedArrayBuffer-backed SteerWorld.
// The SAME code builds the typed-array views on BOTH the main thread (coordinator)
// and inside each worker, so the two can never disagree on layout/offsets. The
// main thread allocates the SABs once per match (allocWorldSabs) and ships them to
// workers; each side then calls viewWorld() to get a SteerWorld over them.

import { SPATIAL_TILE } from "../ai/constants";
import type { SteerWorld } from "../ai/steer";

// One SharedArrayBuffer per logical array, keyed by name. Posting this whole record
// to a worker shares every buffer (SABs are shared by inclusion, never transferred).
export interface WorldSabs {
  grid: SharedArrayBuffer;
  px: SharedArrayBuffer;
  py: SharedArrayBuffer;
  pdir: SharedArrayBuffer;
  palive: SharedArrayBuffer;
  pcharged: SharedArrayBuffer;
  pescapeSteps: SharedArrayBuffer;
  paiCooldown: SharedArrayBuffer;
  pai: SharedArrayBuffer;
  tileStart: SharedArrayBuffer;
  tileItems: SharedArrayBuffer;
  profHunt: SharedArrayBuffer;
  profSeek: SharedArrayBuffer;
  profFlood: SharedArrayBuffer;
  profOpen: SharedArrayBuffer;
  profStraight: SharedArrayBuffer;
  profJitter: SharedArrayBuffer;
  profStalk: SharedArrayBuffer;
  profPathfind: SharedArrayBuffer;
  profAvoid: SharedArrayBuffer;
  profAvoidRange: SharedArrayBuffer;
  profNoCoast: SharedArrayBuffer;
  dueList: SharedArrayBuffer; // AI indices to plan this pass (len n)
}

export function tilesFor(cols: number, rows: number): { tilesX: number; tilesY: number } {
  return {
    tilesX: Math.max(1, Math.ceil(cols / SPATIAL_TILE)),
    tilesY: Math.max(1, Math.ceil(rows / SPATIAL_TILE)),
  };
}

const SAB = (bytes: number) => new SharedArrayBuffer(bytes);

export function allocWorldSabs(cols: number, rows: number, n: number): WorldSabs {
  const cells = cols * rows;
  const { tilesX, tilesY } = tilesFor(cols, rows);
  const nt = tilesX * tilesY;
  const I16 = Int16Array.BYTES_PER_ELEMENT;
  const I32 = Int32Array.BYTES_PER_ELEMENT;
  const I8 = 1;
  const F64 = Float64Array.BYTES_PER_ELEMENT;
  return {
    grid: SAB(cells * I16),
    px: SAB(n * I32),
    py: SAB(n * I32),
    pdir: SAB(n * I8),
    palive: SAB(n * I8),
    pcharged: SAB(n * I8),
    pescapeSteps: SAB(n * I32),
    paiCooldown: SAB(n * I32),
    pai: SAB(n * I8),
    tileStart: SAB((nt + 1) * I32),
    tileItems: SAB(n * I32),
    profHunt: SAB(n * F64),
    profSeek: SAB(n * F64),
    profFlood: SAB(n * F64),
    profOpen: SAB(n * F64),
    profStraight: SAB(n * F64),
    profJitter: SAB(n * F64),
    profStalk: SAB(n * I8),
    profPathfind: SAB(n * I8),
    profAvoid: SAB(n * F64),
    profAvoidRange: SAB(n * F64),
    profNoCoast: SAB(n * I8),
    dueList: SAB(n * I32),
  };
}

// Build typed-array views over the shared buffers, assembled into a SteerWorld.
// `dueList` is returned separately (it's not part of SteerWorld).
export function viewWorld(
  sabs: WorldSabs,
  cols: number,
  rows: number,
  n: number,
): { world: SteerWorld; dueList: Int32Array } {
  const { tilesX, tilesY } = tilesFor(cols, rows);
  const world: SteerWorld = {
    cols,
    rows,
    n,
    grid: new Int16Array(sabs.grid),
    px: new Int32Array(sabs.px),
    py: new Int32Array(sabs.py),
    pdir: new Int8Array(sabs.pdir),
    palive: new Uint8Array(sabs.palive),
    pcharged: new Uint8Array(sabs.pcharged),
    pescapeSteps: new Int32Array(sabs.pescapeSteps),
    paiCooldown: new Int32Array(sabs.paiCooldown),
    pai: new Uint8Array(sabs.pai),
    tilesX,
    tilesY,
    tileStart: new Int32Array(sabs.tileStart),
    tileItems: new Int32Array(sabs.tileItems),
    profHunt: new Float64Array(sabs.profHunt),
    profSeek: new Float64Array(sabs.profSeek),
    profFlood: new Float64Array(sabs.profFlood),
    profOpen: new Float64Array(sabs.profOpen),
    profStraight: new Float64Array(sabs.profStraight),
    profJitter: new Float64Array(sabs.profJitter),
    profStalk: new Uint8Array(sabs.profStalk),
    profPathfind: new Uint8Array(sabs.profPathfind),
    profAvoid: new Float64Array(sabs.profAvoid),
    profAvoidRange: new Float64Array(sabs.profAvoidRange),
    profNoCoast: new Uint8Array(sabs.profNoCoast),
  };
  return { world, dueList: new Int32Array(sabs.dueList) };
}
