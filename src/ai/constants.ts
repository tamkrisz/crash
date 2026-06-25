// Shared AI + grid constants, factored out of game.ts so the single-threaded
// Game AND the Web Worker steering module (steer.ts) read the SAME values. Keep
// this the only definition — game.ts imports from here. If you retune a knob,
// you retune it for both execution paths at once, so parallel bots can never
// drift from serial bots.

// ---- grid cell sentinels (values >= 0 are a player id / trail) -------------
export const WALL = -2;
export const EMPTY = -1;
export const DEATH = -3;

// ---- steering tuning -------------------------------------------------------
// (2r+1)^2 openness box radius — the anti-spiral term.
export const OPEN_RADIUS = 3;

// Hunter pathfinding (breach-aware Dijkstra to the nearest rival).
export const PF_RANGE = 90;
export const PF_NODES = 14000;
export const PF_WALL_COST = 6;
export const PF_PATH_BONUS = 1e6;
export const PF_MIN_FLOOD = 4;

// Thick-barrier avoidance. A run of MORE than PF_MAX_WALL_RUN consecutive
// breakable cells between hunter and prey is a near-impassable barrier: entering
// a wall cell that still has more than this many walls ahead of it (in the
// hunter's travel direction) costs PF_WALL_RUN_PENALTY on top of PF_WALL_COST.
// That makes the breach-aware Dijkstra prefer ANY finite go-around, and only
// route straight through (so the hunter digs) when no detour exists. Thin walls
// (<= the cap) still cost only PF_WALL_COST each, so small obstacles are bored
// through exactly as before. PENALTY is finite and far below PF_PATH_BONUS, and
// small enough that cost*n + cell never overflows a safe integer on real grids.
export const PF_MAX_WALL_RUN = 10;
export const PF_WALL_RUN_PENALTY = 1e5;

// A hunter only adds its (dominant) hunt/aim bonus to a candidate move when that
// cell still floods to at least this much reachable room. Chasing into a cell
// with less space than this is how a hunter boxes itself against its own and
// rivals' trails — by far the #1 killer in a dense field. Below the threshold the
// move is scored on survival (flood + openness) alone, so the bot peels off into
// open space instead of diving after prey into a collapsing pocket. It still hunts
// hard everywhere there's room; it just won't chase into a trap.
export const HUNT_MIN_FLOOD = 60;

// Spatial bucket-grid tile size for nearestRival.
export const SPATIAL_TILE = 16;

// Staggered planning (see Game.aiThink / steer.planOne).
export const AI_THINK_PERIOD = 3;
// Cycle count at/above which the per-cycle AI fast paths engage TOGETHER:
//   - the multi-threaded worker pool (setupParallel / parallelEngaged)
//   - staggered "coasting" planning (Game.aiThink + steer.planOne)
//   - the O(range) head-map firing-line lookup (rebuildSpatial + lineOfFireRival)
// They share ONE threshold on purpose so a parallel bot can never drift from a
// serial bot. Below it the field runs the proven single-threaded path, bit-for-bit
// identical to the original AI. This used to be 256 (so the fast paths only ever
// helped tera-scale fields); at 24 they kick in for ordinary crowded matches —
// which is exactly where the single-threaded per-cycle steering scan started to
// lag. Tuning knob: lower it (e.g. 16) to parallelize smaller fields, raise it to
// keep more small-field exactness. Worker handshake overhead makes very low values
// (< ~12) a net loss.
export const AI_STAGGER_MIN_CYCLES = 24;
export const COAST_RUNWAY = 6;
export const COAST_OPEN_MIN = 40;
