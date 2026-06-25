import { Player, CHARGE_MAX } from "./player";
import { brighten, darken, hslToHex } from "./colors";
import {
  DELTA,
  opposite,
  PALETTE,
  HUMAN_KEYS,
  PERSONALITIES,
  type Dir,
  type Difficulty,
  type GameMode,
  type MatchConfig,
  type PlayerConfig,
  type QuadSpec,
  type AiProfile,
  type Personality,
  type AiRoster,
  MAP_DIMENSIONS,
  QUAD_SPECS,
} from "./types";
import { MAPS, type ArenaMap } from "./maps";
import {
  WALL,
  EMPTY,
  DEATH,
  OPEN_RADIUS,
  PF_RANGE,
  PF_NODES,
  PF_WALL_COST,
  PF_PATH_BONUS,
  PF_MIN_FLOOD,
  PF_MAX_WALL_RUN,
  PF_WALL_RUN_PENALTY,
  HUNT_MIN_FLOOD,
  SPATIAL_TILE,
  AI_THINK_PERIOD,
  AI_STAGGER_MIN_CYCLES,
  COAST_RUNWAY,
  COAST_OPEN_MIN,
} from "./ai/constants";
// WALL/EMPTY/DEATH are grid cell sentinels; the rest are AI tuning knobs. All now
// live in ./ai/constants so the Web Worker steering path shares them — see that file.
import type { SteerWorld } from "./ai/steer";
import { ParallelAi } from "./parallel/coordinator";
import { detectParallel, type ParallelCaps } from "./parallel/caps";

// The world is a torus: opposite edges connect, so the camera can keep the
// player centred forever. A destroyable frame BORDER cells thick lines every
// edge; because opposite frames meet at the wrap seam, crossing from one
// interior edge to the other means tunnelling through ~2*BORDER (~20) blocks of
// border before you pop out the far side. The frame is built from WALL cells,
// which already block movement yet are cleared by a rocket blast (see detonate).
const BORDER = 10;

const SPEED_INTERVAL: Record<MatchConfig["speed"], number> = {
  slow: 110,
  normal: 80,
  fast: 56,
};

// A distinct colour for cycle slot `i`. The hand-tuned PALETTE covers the first
// few players; beyond that we spin the hue wheel by the golden angle so even a
// 32-cycle grid stays readable.
function slotColor(i: number): string {
  if (i < PALETTE.length) return PALETTE[i].color;
  const hue = ((i - PALETTE.length) * 137.508) % 360;
  return hslToHex(hue, 0.7, 0.62);
}

// A short cycle name for bot slot `i` (PALETTE names for the first few).
function botName(i: number): string {
  if (i < PALETTE.length) return PALETTE[i].name.slice(0, 3) + "-BOT";
  return "BOT-" + (i + 1);
}

const CHARGE_RATE = CHARGE_MAX / 3000; // full recharge in ~3s
const PROJ_INTERVAL = 11; // ms per cell travelled
const PROJ_RANGE = 260; // effectively flies until it hits something (can leave screen)
const BLAST = 5; // rocket blast clears + kills in a BLAST x BLAST block
// cells from the blast centre to its edge — a cycle this close (or closer) to a
// detonation is caught in it. Used so bots don't blast a wall point-blank and
// kill themselves with their own escape/breach shots.
const BLAST_RADIUS = Math.floor(BLAST / 2);
const DEATH_BLAST = 5; // death explosion flash is DEATH_BLAST x DEATH_BLAST cells
const EXPLOSION_MS = 280; // blast flash lifetime

// Spectator camera (only active while a downed pilot is watching the field): how
// far in you can zoom and the multiplier applied per zoom step. The zoom-OUT
// floor is computed per view (minZoom); past one world copy the torus simply
// tiles into view (entities are drawn in every visible copy — see visibleShifts).
const SPEC_ZOOM_MAX = 2.2; // tightest spectator zoom-in
const SPEC_ZOOM_STEP = 1.18; // per keypress / wheel notch
const SPEC_PAN_FRAC = 0.15; // free-look keyboard pan, as a fraction of the framed window
// how far past the whole-arena framing you may keep zooming out: at the floor the
// window spans SPEC_ZOOM_OUT_X world copies across its limiting axis (the torus
// repeats into the rest), subject to the per-frame cell cap below.
const SPEC_ZOOM_OUT_X = 5;
// hard ceiling on how many grid cells a spectator view may frame at once. The
// zoom-out floor (minZoom) never drops below this — on a giant arena (giga/tera)
// zooming fully out would otherwise scan millions of cells per frame *during* the
// live sim. ~160x the normal ~3.1k-cell window.
const SPEC_MAX_VISIBLE_CELLS = 500_000;

// Per-difficulty AI behaviour. Shooting and steering both scale with skill. The
// field-by-field documentation lives with the AiProfile interface in types.ts;
// the notes below cover only what's specific to a given difficulty tier.
// (OPEN_RADIUS, the openness scan-box radius, now lives in ./ai/constants.)
// steps an escaping bot commits to driving straight through its blasted hole
const ESCAPE_STEPS = 7;
// a clear straightaway this long ahead is worth sprinting down
const SPRINT_RUNWAY = 16;
// Turtle escape planning (the `escapeAim` trait). When a route-out bot is getting
// boxed in, it scans this many cells ahead in each heading for the wall it would
// blast through, then floods the space the blast would reveal — so it aims its
// escape at REAL open arena instead of punching a hole into another arm of its own
// coil (the old blind escape blast's failure mode). It only commits toward a wall
// it must breach when its rocket will be charged by the time it arrives (travel
// distance vs reload time, see aiEscapePlan); otherwise it circles to recharge.
const ESC_LOOK = 6;
// Escape AIMING is a LAST resort, not an eager habit: diverting a space-filler
// toward a wall to punch a hole actually traps it (it abandons the fill it was
// doing). So the steering override only kicks in once reachable room falls this
// low — by then it really is escape-or-die and the diversion can't make things
// worse. (The escape blast itself still triggers at the higher escapeSpace
// threshold, and is NEVER withheld — see aiMaybeShoot.)
const ESC_STEER_CRIT = 90;
// The escape steering only bothers to AIM at a breach when that breach opens at
// least this many times the room we'd keep by not diverting — otherwise there's no
// better exit to aim at, so we leave the greedy survival steer alone. (This only
// gates where we STEER; it never blocks the shot, which fires whenever boxed.)
const ESC_GAIN = 1.5;
// how many cells ahead a dodging bot (the hunter) tracks an incoming rocket. A
// rocket flies ~5-10x faster than a cycle, so to sidestep its blast band the bot
// must spot it several cells out — this horizon buys ~4-5 steps of warning, just
// enough to break clear before it arrives (see dodgeDir / aiAvoidDanger).
const DODGE_HORIZON = 36;
// A fired rocket is nearly impossible to outrun at point-blank range, so the
// dodger also reads the SHOT BEFORE IT'S FIRED: if a rival within this many cells
// has the bot lined up on its heading, the bot steps off that line pre-emptively.
// Covers the realistic close-duel kill range (a hunter's aimRange at normal/hard)
// so it breaks off before the rival is even in firing range; kept bounded so it
// doesn't flinch at the arena-wide aim of the expert tiers. A fellow dodger
// (another hunter) counts as a threat here even while its rocket is recharging —
// it WILL re-arm, and we don't want to be sitting on its line when it does (this
// is a big part of what stops two hunters trading muzzle-to-muzzle kills).
const DODGE_PREDICT = 24;

// Hunter pathfinding (breach-aware shortest path to the nearest rival).
//   PF_RANGE     only pathfind to a target within this Manhattan distance; farther
//                away, greedy steering is good enough and a full search is wasteful
//   PF_NODES     Dijkstra expansion budget per query (bounds cost on huge maps)
//   PF_WALL_COST cost of routing the path through one breakable cell vs a free one.
//                ~this many open cells of detour are "worth" avoiding one wall cell,
//                so the path goes around small obstacles but bores straight through
//                a thick wall when going around would be much longer.
//   PF_PATH_BONUS steering reward for taking the path's first step (dominant, so the
//                bot follows the route; survival flood still vetoes a dead end)
//   PF_MIN_FLOOD don't follow the path into a cell with less reachable room than
//                this — a guard against ever steering into an immediate trap
//
// PF_*, AI_THINK_PERIOD, AI_STAGGER_MIN_CYCLES, COAST_*, and SPATIAL_TILE now live
// in ./ai/constants (imported above) so the worker steering path shares them.
//   AI_THINK_PERIOD     re-run the full steering scan every Nth step; coast (reuse
//                       heading) in between. ~Nx off the dominant flood-fill cost.
//   AI_STAGGER_MIN_CYCLES staggering only engages at/above this cycle count (tera+);
//                       smaller fields run the full brain every step.
//   COAST_RUNWAY/OPEN   a bot may only coast while cruising demonstrably open arena
//                       (long clear runway + open surroundings); anywhere tight it
//                       re-plans, so trap-avoidance is preserved.
//   SPATIAL_TILE        bucket-grid tile size for the O(N)->local nearestRival query.

const AI_DIFFICULTY: Record<Difficulty, AiProfile> = {
  easy: {
    aimRange: 6,
    aimTake: 0.4,
    lead: false,
    escape: true,
    escapeSpace: 40,
    openRate: 0.05,
    flood: 60,
    open: 0.3,
    hunt: 1.5,
    straight: 4,
    jitter: 16,
  },
  hard: {
    aimRange: 24,
    aimTake: 0.92,
    lead: true,
    escape: true,
    escapeSpace: 120,
    openRate: 0.1,
    flood: 240,
    open: 0.7,
    hunt: 6,
    straight: 6,
    jitter: 3,
  },
  // Unfair on purpose — close to impossible to kill. Arena-wide sight, never
  // declines a clean shot, leads movement, and relentlessly hunts charged
  // rivals. It panics out of even a sliver of a pocket (massive escapeSpace),
  // cracks walls open constantly to keep room, looks ahead extremely far so it
  // practically never drives into a dead end, and sprints every single step for
  // relentless pressure. Don't expect to outlast it — try to out-shoot it.
  cheating: {
    aimRange: 999,
    aimTake: 1,
    lead: true,
    escape: true,
    escapeSpace: 1200,
    openRate: 0.4,
    flood: 2000,
    open: 2.6,
    hunt: 20,
    straight: 6,
    jitter: 0,
    alwaysSprint: true,
  },
  // NOT hand-tuned. Bred in train/ by a genetic algorithm over tens of thousands
  // of simulated matches, then hardened by 50 generations of SELF-PLAY (each
  // candidate fought a hall of fame of past champions). A first pass trained only
  // against cheating HUNTERS overfit badly — it beat hunters ~72% but lost to a
  // MIXED cheating field (~16%, below chance). Self-play produced this robust
  // all-rounder instead: still strong vs hunters (~62%) AND well above chance vs
  // mixed cheating fields (~34-40%, where chance is 17-25%), generalizing even to
  // arena sizes it never trained on. It's an aggressive duelist — sprints
  // constantly, packs space tight (negative `open`), dodges incoming fire, and
  // takes its shots. Use with the BALANCED character for the profile as evolved.
  evolved: {
    aimRange: 861,
    aimTake: 0.94,
    lead: true,
    escape: true,
    escapeSpace: 360,
    openRate: 0.06,
    flood: 1245,
    open: -0.33,
    hunt: 67,
    straight: 4.63,
    jitter: 0,
    alwaysSprint: true,
    stalk: false,
    breach: false,
    pathfind: false,
    dodge: true,
    seekRange: 83239,
    pacifist: false,
  },
};

// AI characters. Each is a transform applied to the chosen difficulty profile,
// so the SKILL dial still sets competence while the character sets STYLE. The
// transforms scale the base knobs rather than hardcoding values, so a character
// stays recognisable across every difficulty (a hunter is always pushier than a
// survivor, at every skill). See PERSONALITIES (types.ts) for the descriptions.
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const PERSONALITY_STYLE: Record<Personality, (b: AiProfile) => AiProfile> = {
  // The neutral all-rounder: the difficulty profile, unchanged. This is exactly
  // what every bot used before characters existed, so a default match is the same.
  balanced: (b) => b,

  // Pure aggressor — its sole purpose is to find and kill. `stalk` plus an
  // arena-wide `seekRange` mean it always locks onto the nearest rival and chases
  // it, charged or not, anywhere on the map. A dominant hunt weight with almost
  // no pull toward open space or straight lines keeps it beelining at the target
  // rather than driving for territory, and it takes practically every shot. Aim
  // *precision/range* still scales with skill (so an easy hunter misses more and
  // sees less), but the relentless pursuit is the same at every difficulty. It
  // saves rockets for rivals rather than cracking walls. escapeSpace stays high
  // enough that it bails out before suiciding — survival serves the hunt, not the
  // other way around. `dodge` adds a reflex on top: it reads incoming enemy
  // rockets and sidesteps out of the blast band, then snaps straight back onto
  // the chase — danger-aware without ever easing off the aggression.
  hunter: (b) => ({
    ...b,
    stalk: true,
    breach: true,
    pathfind: true,
    dodge: true,
    alwaysSprint: true,
    seekRange: 100000,
    aimRange: Math.round(b.aimRange * 1.8),
    aimTake: clamp01(b.aimTake + 0.3),
    hunt: b.hunt * 4 + 10,
    // Real anti-spiral pull (was 0.15x — far too low, so the bot coiled itself
    // into a dead end while beelining; a lone hunter trapped itself in seconds).
    // The hunt term still dwarfs this several times over when a target is in
    // reach, so it keeps beelining at prey; the openness pull only takes over when
    // hunt is weak (no target, or one too far to chase) and otherwise just steers
    // it clear of its own trail. Survival serves the hunt — it does not suicide
    // for it. A profile sweep put the survival/aggression sweet spot here: lone
    // survival climbs from ~8% to ~50% with the hunt behaviour intact. Paired with
    // a deeper survival look-ahead (flood) so it sees the trap coming earlier.
    open: b.open * 1.2,
    flood: Math.round(b.flood * 1.25),
    straight: b.straight * 0.4,
    openRate: b.openRate * 0.15,
    // bail out of a tightening pocket EARLY (scaled up, not down): it must spot
    // the collapsing coil while a wall is still far enough ahead to blast a clean
    // escape hole from a safe standoff, rather than discovering it point-blank.
    escapeSpace: Math.round(b.escapeSpace * 1.3),
  }),

  // HUNTER+ : a trained killer. Not hand-tuned and not a transform of the base —
  // this fixed profile was bred by the genetic algorithm in train/hunterplus.ts in
  // GIGA mode (128 cycles) with KILLS as the sole objective. Over 960 sampled giga
  // matches it out-killed the stock cheating hunter ~64% (1.04 vs 0.64 kills/match).
  // Because it's a fixed trained artifact it ignores `b` (the skill dial) — it's
  // always elite. What the GA discovered: precise long-range aim (it takes nearly
  // every clean shot) and `pathfind`+`dodge` to chase prey and slip incoming fire,
  // but it DROPPED breach/stalk and sets openRate 0 — it never wastes a rocket on a
  // wall, saving every shot for a rival. A very deep `flood` look-ahead plus a high
  // `escapeSpace` keep it alive far longer than a reckless hunter, so it racks up
  // more kills over the match. Positive `open` keeps it in the clear where targets
  // and escape routes are; low `straight` lets it turn freely to line up shots.
  hunterplus: () => ({
    aimRange: 1384,
    aimTake: 0.99,
    lead: true,
    escape: true,
    escapeSpace: 1500,
    openRate: 0,
    flood: 2616,
    open: 2.43,
    hunt: 58,
    straight: 0.81,
    jitter: 0.83,
    alwaysSprint: true,
    stalk: false,
    breach: false,
    pathfind: true,
    dodge: true,
    seekRange: 90570,
    pacifist: false,
  }),

  // Tightest fit. The openness term goes NEGATIVE, so instead of fleeing to open
  // arena it hugs its own trail and the walls, packing the most compact coil it
  // can. Turns freely (low straight) to fill every gap. Flood look-ahead stays
  // high so it still sees the dead end coming and doesn't simply suffocate.
  packer: (b) => ({
    ...b,
    open: -(0.6 + b.open * 0.4),
    straight: b.straight * 0.35,
    hunt: b.hunt * 0.5,
    jitter: b.jitter * 0.4,
    flood: Math.round(b.flood * 1.15),
    escapeSpace: Math.round(b.escapeSpace * 0.7),
  }),

  // Speed-demon. Lives for long straight runs — a huge straight bonus and almost
  // no jitter keep it laser-straight, turning only when a wall forces it. Sprints
  // every step to lay line fast. Doesn't go out of its way to fight.
  runner: (b) => ({
    ...b,
    straight: b.straight * 4 + 6,
    jitter: b.jitter * 0.25,
    open: b.open * 0.7,
    hunt: b.hunt * 0.6,
    alwaysSprint: true,
  }),

  // Pure pacifist turtle. It does not fight, ever: `pacifist` strips out the kill
  // shot, the breach, and opportunistic wall-cracking, so the only rocket it ever
  // fires is the last-ditch escape blast — and even that only once it's genuinely
  // cornered (see aiMaybeShoot). Everything else is tuned to stay alive: a big
  // openness pull and deep flood to hoard breathing room, never seeks a rival
  // (hunt 0), never sprays walls (openRate 0). It plays purely to be the last one
  // standing. escapeSpace is scaled UP from the difficulty base (1.5x) so the
  // survivor bails early, while a real exit is still in reach — its whole job is
  // to outlast everyone, so it must spot its own tightening coil long before the
  // pocket collapses. A fixed-low threshold made it blind past ~24 reachable
  // cells (openSpace caps its flood at escapeSpace) and only fire once already
  // boxed in, so the escape blast just punched into another arm of the coil.
  survivor: (b) => ({
    ...b,
    pacifist: true,
    open: b.open * 2 + 0.6,
    flood: Math.round(b.flood * 1.4),
    escapeSpace: Math.round(b.escapeSpace * 1.5),
    hunt: 0,
    aimTake: 0,
    openRate: 0,
  }),

  // The turtle — the survivor's proven space-filling brain, pushed further toward
  // pure survival. It keeps the survivor's tuned core (the same openness pull, the
  // same patient straight/jitter that lays long lines without curling into a trap —
  // both stronger AND weaker straight measurably self-trap, so we don't touch it)
  // and layers on what the name promises:
  //   • flood look-ahead 2x as deep as the survivor — it "sees far into the future",
  //     spotting a closing region well before it's a problem (this is where the
  //     extra CPU goes, alongside `noCoast`, which re-plans every single step);
  //   • `avoid` — actively FLEES the nearest rival (the survivor merely ignores
  //     them), but only one that's genuinely close (a short avoidRange): a wide
  //     repulsion makes two turtles herd each other into the walls, so it's kept
  //     tight and bounded — the flood/openness terms always dominate;
  //   • `dodge` — sidesteps an incoming rocket;
  //   • `escapeAim` — when it does get boxed, it aims its escape blast at the
  //     heading that opens the MOST room (not just whatever's straight ahead) and
  //     only commits toward a wall once the rocket will be charged by the time it
  //     gets there (travel distance vs reload, see aiEscapePlan). Strictly a last
  //     resort, so it never disrupts the space-filling that keeps it alive — and it
  //     never withholds the shot itself (when truly boxed, any blast buys life).
  // Its whole and only purpose is to be the last one standing.
  turtle: (b) => ({
    ...b,
    pacifist: true,
    dodge: true,
    noCoast: true,
    escapeAim: true,
    avoid: Math.min(10, 5 + b.hunt * 0.3),
    avoidRange: 30,
    open: b.open * 2 + 0.8,
    flood: Math.round(b.flood * 2),
    escapeSpace: Math.round(b.escapeSpace * 1.5),
    hunt: 0,
    aimTake: 0,
    openRate: 0,
  }),

  // Wall-breaker. Blasts walls open constantly (high openRate) to keep the arena
  // flowing, sprints flat out, and fights eagerly. The extra jitter makes its
  // path chaotic and hard to read. Spends rockets freely — feast or famine.
  demolisher: (b) => ({
    ...b,
    openRate: clamp01(b.openRate * 3 + 0.2),
    hunt: b.hunt * 1.3,
    jitter: b.jitter * 1.6 + 2,
    escapeSpace: Math.round(b.escapeSpace * 1.2),
    alwaysSprint: true,
  }),

  // Explorer. Strongly drawn to open arena (huge openness weight) and keeps long
  // lines, so it ranges wide claiming fresh territory rather than coiling tight
  // or chasing rivals. Light on combat.
  roamer: (b) => ({
    ...b,
    open: b.open * 2.6 + 0.8,
    straight: b.straight * 1.6,
    hunt: b.hunt * 0.5,
    flood: Math.round(b.flood * 1.2),
    jitter: b.jitter * 0.6,
  }),

  // Stalker. The `stalk` flag makes it shadow the nearest rival even with an empty
  // rocket, steering to close the gap and swing across their path — then it cuts
  // in to force a crash. Long sight and an eager trigger finish the job.
  ambusher: (b) => ({
    ...b,
    stalk: true,
    aimRange: Math.round(b.aimRange * 1.5),
    aimTake: clamp01(b.aimTake + 0.15),
    hunt: b.hunt * 1.8 + 3,
    open: b.open * 0.7,
    escapeSpace: Math.round(b.escapeSpace * 0.9),
  }),
};

// Combine a skill tier and a character into the concrete profile a bot drives by.
function buildProfile(diff: Difficulty, personality: Personality): AiProfile {
  return PERSONALITY_STYLE[personality](AI_DIFFICULTY[diff]);
}

// short tag per character, for naming bots (e.g. "HUN2")
const PERSONALITY_CODE = Object.fromEntries(
  PERSONALITIES.map((p) => [p.id, p.code]),
) as Record<Personality, string>;
const ALL_PERSONALITIES = PERSONALITIES.map((p) => p.id);

interface Spawn {
  x: number;
  y: number;
  dir: Dir;
}

interface Projectile {
  x: number;
  y: number;
  dir: Dir;
  owner: number;
  color: string;
  range: number;
  acc: number;
}

interface Explosion {
  x: number; // top-left cell of the blast square
  y: number;
  size: number; // width/height of the blast square in cells
  age: number;
  life: number;
}

interface View {
  player: Player; // the human this viewport belongs to
  // while `player` is dead, the camera follows this cycle instead (spectate).
  // null until a target is picked; reset each round.
  spectate: Player | null;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  camx: number;
  camy: number;
  // spectator camera state, only meaningful while `player` is dead. zoom is a
  // pixels-per-cell multiplier (1 = the normal follow framing, <1 zooms out to
  // take in more of the arena, >1 zooms in). `free` detaches the camera from the
  // followed cycle so it can be panned around freely (free-look); switching the
  // followed cycle re-locks it. Both reset every round (see startRound).
  zoom: number;
  free: boolean;
}

export type GameState = "playing" | "roundover" | "idle";

export interface GameCallbacks {
  onRoundOver: (game: Game) => void;
  onStatus: (text: string) => void;
}

export class Game {
  // grid dimensions can change between matches (see resize / newMatch)
  cols: number;
  rows: number;
  readonly cell: number;
  readonly viewW: number;
  readonly viewH: number;
  worldW: number;
  worldH: number;

  private grid: Int16Array;
  // direction the trail was laid in at each cell (a Dir), used to orient the
  // chevron arrows when drawing the line. Only meaningful where grid >= 0.
  private dirs: Int8Array;
  // persistent scorch marks: 1 where an explosion has happened. Purely visual,
  // does not block movement.
  private scorch: Uint8Array;
  private ctx: CanvasRenderingContext2D;
  private cb: GameCallbacks;
  private bgPattern: CanvasPattern | null;

  // hunter pathfinder scratch (lazily sized to the grid; see pathToward). The
  // stamp/gen pair lets us treat dist/next as "empty" each query without clearing
  // the whole grid — a cell's value is only valid when its stamp matches pfGen.
  private pfDist: Float64Array | null = null;
  private pfStamp: Int32Array | null = null;
  private pfNext: Int8Array | null = null;
  private pfHeap: Float64Array | null = null;
  private pfGen = 0;

  players: Player[] = [];
  projectiles: Projectile[] = [];
  explosions: Explosion[] = [];
  views: View[] = [];
  // living-cycle count, maintained incrementally as cycles die (set to the full
  // roster each startRound, decremented on every death). Lets the hot per-frame
  // and per-tick paths read a count without re-filtering the whole roster — see
  // checkRoundOver and main.ts's frame loop.
  aliveCount = 0;
  state: GameState = "idle";
  winnerName: string | null = null;
  winner: Player | null = null;
  // true when the round was called early by a downed human bailing out rather
  // than fought to a natural finish — lets the results screen say so and skips
  // crowning a winner.
  endedEarly = false;
  private currentMap: ArenaMap = MAPS[0];
  private aiDifficulty: Difficulty = "hard";
  private gameMode: GameMode = "classic";
  // the active quad-mode layout (mega/giga), or null in classic mode
  private quadSpec: QuadSpec | null = null;

  // flood-fill scratch (stamped to avoid per-call clears)
  private stamp: Int32Array;
  private stampGen = 0;
  // reused BFS frontier for floodCount, sized to the whole grid (a flood can
  // touch at most every cell once). Preallocated so the hot path never allocates
  // — the old per-call `number[]` queue was ~1.5k array allocations per frame.
  private floodQueue: Int32Array;

  // Head map: which cycle's HEAD sits on each cell this snapshot (stamped like the
  // flood scratch). Lets enemyInLineOfFire test "is a rival head on my firing line"
  // in O(1) per cell instead of scanning every cycle — turning that shot check from
  // O(range*N) into O(range). Built in rebuildSpatial, and only for large fields
  // (small fields keep the exact live scan, so their shooting is unchanged).
  private headStamp: Int32Array;
  private headOwner: Int32Array;
  private headGen = 0;

  // spatial bucket grid for nearestRival (rebuilt each frame; see ensureSpatial /
  // rebuildSpatial / nearestRival). CSR layout: tileStart[t]..tileStart[t+1] index
  // into tileItems, which holds the player indices bucketed into tile t.
  private tilesX = 0;
  private tilesY = 0;
  private tileStart = new Int32Array(1);
  private tileCursor = new Int32Array(0);
  private tileItems = new Int32Array(0);

  // Parallel AI (Web Worker pool over SharedArrayBuffer). null when the page can't
  // support it (not cross-origin isolated, no SAB) — then we always run serial.
  // Engaged only for large fields (see parallelEngaged). caps is kept for the HUD.
  private parallel: ParallelAi | null = null;
  readonly parallelCaps: ParallelCaps;
  // per-cycle step counter for the parallel round loop (reused per match)
  private stepsTaken = new Int32Array(0);
  // last simulation step duration in ms (for the perf HUD)
  tickMs = 0;

  // per-player smooth trail gradients in local cell space (reused per cell):
  //   v = vertical segment  (bright left -> dark right)
  //   h = horizontal segment (bright top -> dark bottom)
  //   d = corner/elbow       (bright top-left -> dark bottom-right)
  // a single top-left light source keeps straight runs and bends continuous.
  private trailGrads: { v: CanvasGradient; h: CanvasGradient; d: CanvasGradient }[] = [];

  // Reusable scratch for visibleShifts (one per axis), refilled per entity during
  // render instead of allocating a fresh array twice per entity per frame. Safe to
  // share across entities/views because each entity fully consumes them before the
  // next call overwrites them (render is single-threaded, top to bottom).
  private shiftScratchX: number[] = [];
  private shiftScratchY: number[] = [];

  // Fixed-capacity (10) "closest off-screen rivals" buffers for drawOffscreenIndicators,
  // kept sorted ascending by squared distance. Filling these via bounded insertion
  // avoids allocating one object per rival and full-sorting the roster every frame
  // per view (we only ever draw the 10 nearest anyway).
  private markSx = new Float64Array(10);
  private markSy = new Float64Array(10);
  private markDist = new Float64Array(10);
  private markColor: string[] = new Array(10);

  // Reusable return object for detonationCell — that runs in per-tick shooting
  // decisions, and its two call sites (shotWouldSelfKill) consume the first result
  // before the second is computed, so a single shared object never aliases.
  private detCellBuf = { x: 0, y: 0 };

  // Reusable per-view collectors for the solid grid cells (walls/death/scorch) so
  // renderView can draw them in colour-batched passes (fillStyle set a handful of
  // times per frame instead of ~3x per cell). Refilled each renderView call.
  private wallXs: number[] = [];
  private wallYs: number[] = [];
  private deathXs: number[] = [];
  private deathYs: number[] = [];
  private scorchXs: number[] = [];
  private scorchYs: number[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    cols: number,
    rows: number,
    cell: number,
    viewW: number,
    viewH: number,
    cb: GameCallbacks,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.viewW = viewW;
    this.viewH = viewH;
    this.worldW = cols * cell;
    this.worldH = rows * cell;
    this.cb = cb;
    canvas.width = viewW;
    canvas.height = viewH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
    this.grid = new Int16Array(cols * rows);
    this.dirs = new Int8Array(cols * rows);
    this.scorch = new Uint8Array(cols * rows);
    this.stamp = new Int32Array(cols * rows);
    this.floodQueue = new Int32Array(cols * rows);
    this.headStamp = new Int32Array(cols * rows);
    this.headOwner = new Int32Array(cols * rows);
    this.bgPattern = this.makeBgPattern();

    // Stand up the worker pool if the page supports it. Buffers are sized per
    // match (setupParallel); the pool is reused across matches of the same shape.
    this.parallelCaps = detectParallel();
    this.parallel = this.parallelCaps.available
      ? new ParallelAi(this.parallelCaps.workerCount)
      : null;
  }

  // Re-dimension the world to a new cell grid, reallocating every per-cell
  // buffer. No-op when the size is unchanged. Always followed by startRound,
  // which clears and rebuilds the grid contents.
  private resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.worldW = cols * this.cell;
    this.worldH = rows * this.cell;
    this.grid = new Int16Array(cols * rows);
    this.dirs = new Int8Array(cols * rows);
    this.scorch = new Uint8Array(cols * rows);
    this.stamp = new Int32Array(cols * rows);
    this.floodQueue = new Int32Array(cols * rows);
    this.headStamp = new Int32Array(cols * rows);
    this.headOwner = new Int32Array(cols * rows);
  }

  private wrapX(x: number): number {
    return ((x % this.cols) + this.cols) % this.cols;
  }

  private wrapY(y: number): number {
    return ((y % this.rows) + this.rows) % this.rows;
  }

  // The world is a torus: every coordinate is valid and wraps to the far edge,
  // so callers no longer bounds-check — they just read/write through here.
  private idx(x: number, y: number): number {
    return this.wrapY(y) * this.cols + this.wrapX(x);
  }

  private isFree(x: number, y: number): boolean {
    return this.grid[this.idx(x, y)] === EMPTY;
  }

  // Shift cell coordinate `coord` by whole worlds so it lands nearest the centre
  // of a camera window, used to draw torus-wrapped entities in the right copy.
  private wrapNearCell(
    coord: number,
    camPx: number,
    viewSize: number,
    span: number,
  ): number {
    const centerCell = (camPx + viewSize / 2) / this.cell;
    return coord - span * Math.round((coord - centerCell) / span);
  }

  // Whole-world shifts (in cells, multiples of `span`) that place a cell at
  // `coord` somewhere inside the framed window [camPx, camPx+viewSize) on this
  // axis. Almost always one value — but when the spectator zooms out past a
  // single world copy the torus tiles into view, so an entity must be drawn in
  // each visible copy. A 1-cell margin keeps an entity straddling the edge.
  private visibleShifts(
    coord: number,
    camPx: number,
    viewSize: number,
    span: number,
    out: number[],
  ): number[] {
    const cell = this.cell;
    const start = camPx / cell - 1;
    const end = (camPx + viewSize) / cell + 1;
    const nLo = Math.ceil((start - coord) / span);
    const nHi = Math.floor((end - coord) / span);
    out.length = 0; // reuse the caller's scratch (keeps backing store, no alloc)
    for (let n = nLo; n <= nHi; n++) out.push(n * span);
    return out;
  }

  // ---- match setup -------------------------------------------------------

  newMatch(config: MatchConfig): void {
    const base = SPEED_INTERVAL[config.speed];
    this.gameMode = config.mode ?? "classic";
    this.quadSpec = QUAD_SPECS[this.gameMode] ?? null;
    // quad modes are fixed-size battlegrounds; classic uses the picked size
    const dims = this.quadSpec ?? MAP_DIMENSIONS[config.size] ?? MAP_DIMENSIONS.small;
    this.resize(dims.cols, dims.rows);
    this.currentMap = MAPS.find((m) => m.id === config.map) ?? MAPS[0];
    this.aiDifficulty = config.difficulty ?? "hard";
    this.players = [];

    // a quad mode always fields a full grid (4 * perQuadrant cycles) — the human
    // pilots take the first slots and bots fill the rest, perQuadrant per chamber.
    const total = this.quadSpec ? this.quadSpec.perQuadrant * 4 : null;
    const humans = total ? Math.min(config.humans, total) : config.humans;
    const ai = total ? total - humans : config.ai;

    let pi = 0;
    const configs: PlayerConfig[] = [];
    for (let h = 0; h < humans; h++) {
      // a single local player uses Left Shift to sprint and Space to fire
      const keys =
        humans === 1
          ? { ...HUMAN_KEYS[h], sprint: "ShiftLeft", shoot: "Space" }
          : HUMAN_KEYS[h];
      configs.push({
        name: `P${h + 1}`,
        color: slotColor(pi),
        type: "human",
        keys,
      });
      pi++;
    }
    // assign a character to each bot slot from the roster spec, then name bots
    // after their character (e.g. "HUN2") so the mix is visible at a glance —
    // except plain "balanced" bots, which keep the classic colour-based names so
    // a default match looks exactly as it did before characters existed.
    const personalities = this.resolveRoster(config.roster, ai);
    const charCount: Partial<Record<Personality, number>> = {};
    for (let a = 0; a < ai; a++) {
      const persona = personalities[a];
      const n = (charCount[persona] = (charCount[persona] ?? 0) + 1);
      configs.push({
        name:
          persona === "balanced"
            ? botName(pi)
            : `${PERSONALITY_CODE[persona]}${n}`,
        color: slotColor(pi),
        type: "ai",
        personality: persona,
      });
      pi++;
    }

    configs.forEach((c, i) => {
      const p = new Player(i, c.name, c.color, c.type, base, c.keys);
      if (c.type === "ai") {
        p.personality = c.personality ?? "balanced";
        p.aiProfile = buildProfile(this.aiDifficulty, p.personality);
      }
      this.players.push(p);
    });

    // smooth gradients across the tube cross-section, one set per player
    const cell = this.cell;
    this.trailGrads = this.players.map((p) => {
      const hi = brighten(p.color, 0.62);
      const mid = p.color;
      const lo = darken(p.color, 0.5);
      const v = this.ctx.createLinearGradient(0, 0, cell, 0);
      const h = this.ctx.createLinearGradient(0, 0, 0, cell);
      const d = this.ctx.createLinearGradient(0, 0, cell, cell);
      for (const g of [v, h, d]) {
        g.addColorStop(0, hi);
        g.addColorStop(0.5, mid);
        g.addColorStop(1, lo);
      }
      return { v, h, d };
    });

    this.setupParallel();
    this.setupViews();
    this.startRound();
  }

  // Prepare the parallel AI path for this match: size the shared buffers, point our
  // grid at the shared SAB grid (so workers see every write with no copy), and flash
  // the fixed per-cycle AI profile into the shared table. No-op when unsupported.
  // Workers report "ready" asynchronously; until then parallelEngaged() stays false
  // and the match runs serial — so the first frames are never blocked on startup.
  private setupParallel(): void {
    const par = this.parallel;
    if (!par) return;
    const n = this.players.length;
    // small fields (classic/mega/giga) never fan out — leave the pool parked (or
    // unspawned) and run the untouched serial path
    if (n < AI_STAGGER_MIN_CYCLES) return;
    if (!par.matches(this.cols, this.rows, n)) par.resize(this.cols, this.rows, n);
    const world = par.world;
    if (!world) return;

    // the grid becomes the shared buffer; all of Game's existing reads/writes now
    // land in memory the workers can see
    this.grid = world.grid;
    this.stepsTaken = new Int32Array(n);

    // flatten each cycle's resolved AI profile into the shared per-player table
    // (fixed for the whole match, so we do it once here)
    for (let i = 0; i < n; i++) {
      const p = this.players[i];
      world.pai[i] = p.type === "ai" ? 1 : 0;
      const cfg = p.aiProfile;
      if (!cfg) continue;
      world.profHunt[i] = cfg.hunt;
      world.profSeek[i] = cfg.seekRange ?? cfg.aimRange;
      world.profFlood[i] = cfg.flood;
      world.profOpen[i] = cfg.open;
      world.profStraight[i] = cfg.straight;
      world.profJitter[i] = cfg.jitter;
      world.profStalk[i] = cfg.stalk ? 1 : 0;
      world.profPathfind[i] = cfg.pathfind ? 1 : 0;
      world.profAvoid[i] = cfg.avoid ?? 0;
      // resolve the avoid search radius once, mirroring the main thread's fallback
      world.profAvoidRange[i] = cfg.avoid
        ? cfg.avoidRange ?? cfg.seekRange ?? cfg.aimRange
        : 0;
      world.profNoCoast[i] = cfg.noCoast ? 1 : 0;
    }
  }

  // build split-screen views, one per human player
  private setupViews(): void {
    const humans = this.players.filter((p) => p.type === "human");
    this.views = [];
    if (humans.length <= 1) {
      this.views.push({
        player: humans[0] ?? this.players[0],
        spectate: null,
        rx: 0,
        ry: 0,
        rw: this.viewW,
        rh: this.viewH,
        camx: 0,
        camy: 0,
        zoom: 1,
        free: false,
      });
    } else {
      const gap = 4;
      const halfW = (this.viewW - gap) / 2;
      humans.slice(0, 2).forEach((p, i) => {
        this.views.push({
          player: p,
          spectate: null,
          rx: i === 0 ? 0 : halfW + gap,
          ry: 0,
          rw: halfW,
          rh: this.viewH,
          camx: 0,
          camy: 0,
          zoom: 1,
          free: false,
        });
      });
    }
  }

  startRound(): void {
    this.grid.fill(EMPTY);
    this.scorch.fill(0);
    this.projectiles = [];
    this.explosions = [];

    // destroyable border frame: a band of WALL around every edge. Quad modes can
    // ask for a thicker frame (see QuadSpec.border). The world wraps, so opposite
    // bands meet across the seam — drive or blast through to pop out the far side.
    const border = this.quadSpec?.border ?? BORDER;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (x < border || x >= this.cols - border || y < border || y >= this.rows - border) {
          this.grid[this.idx(x, y)] = WALL;
        }
      }
    }

    // carve interior obstacles (and, in a quad mode, the chamber dividers +
    // tunnels) and work out where every cycle spawns. Each mode returns one
    // spawn per player, indexed by player id.
    const spawns = this.quadSpec
      ? this.buildQuadArena(this.quadSpec)
      : this.buildClassicArena();

    // place the cycles on their spawn cells, clearing a short run-up ahead so a
    // map pillar can never sit right in front of a fresh spawn
    this.players.forEach((p, i) => {
      const s = spawns[i];
      for (let k = 1; k <= 6; k++) {
        const ax = s.x + DELTA[s.dir].x * k;
        const ay = s.y + DELTA[s.dir].y * k;
        this.grid[this.idx(ax, ay)] = EMPTY; // central run-up, never the edge frame
      }
      p.spawn(s.x, s.y, s.dir);
      // stagger first replan so the field's planning load spreads evenly across
      // ticks instead of every bot scanning on the same step (see aiThink)
      p.aiCooldown = p.id % AI_THINK_PERIOD;
      this.grid[this.idx(s.x, s.y)] = p.id;
      this.dirs[this.idx(s.x, s.y)] = s.dir;
    });

    // everyone respawns alive, so clear any leftover spectate target / zoom /
    // free-look and snap each camera onto its own pilot
    for (const v of this.views) {
      v.spectate = null;
      v.zoom = 1;
      v.free = false;
      const t = v.player;
      // always-centred camera: the player sits in the middle of the viewport
      // even at the world edge (the torus + border frame fill what's beyond)
      v.camx = (t.x + 0.5) * this.cell - v.rw / 2;
      v.camy = (t.y + 0.5) * this.cell - v.rh / 2;
    }

    // everyone just respawned alive (Player.spawn sets alive = true)
    this.aliveCount = this.players.length;

    this.winnerName = null;
    this.winner = null;
    this.endedEarly = false;
    this.state = "playing";
  }

  // Lay out the classic single-arena round: stamp the selected map's obstacles
  // over the whole interior, then return one spawn per player spaced evenly on a
  // ring around the world centre, each facing inward.
  private buildClassicArena(): Spawn[] {
    const loX = BORDER;
    const hiX = this.cols - BORDER - 1;
    const loY = BORDER;
    const hiY = this.rows - BORDER - 1;
    const cx = this.cols / 2;
    const cy = this.rows / 2;
    // sit the spawn ring out near the inner edge of the border, clear of the
    // central map obstacles, so a cycle facing inward has room to react
    const radius = Math.min(hiX - loX, hiY - loY) * 0.42;
    const total = this.players.length;
    // A normal field fits comfortably on a single ring (the original layout, kept
    // bit-for-bit). But a very large field packs shoulder-to-shoulder there and,
    // once it exceeds the ring's capacity (~one cycle per 3 cells of circumference),
    // multiple cycles round to the SAME cell and crash the instant the round starts
    // — this is why "500 hunters" mostly died in the first second. Past that cap we
    // spread the field across concentric rings (the same layout the quad modes use)
    // so even hundreds of cycles spawn a safe distance apart.
    const ringCap = Math.floor((2 * Math.PI * radius) / 3);
    const span = Math.min(hiX - loX, hiY - loY) / 2;
    const spawns =
      total <= ringCap
        ? this.players.map((_, i) =>
            this.ringSpawn(i, total, cx, cy, radius, loX, hiX, loY, hiY),
          )
        : this.ringFill(total, cx, cy, span, loX, hiX, loY, hiY);

    // interior obstacles from the selected map (symmetrical, kept central and
    // clear of the spawn ring so nobody crashes on frame one)
    for (const [px, py, w, h] of this.currentMap.build(this.cols, this.rows)) {
      this.fillRect(px, py, w, h);
    }
    return spawns;
  }

  // Lay out a quad-mode battleground: two destructible divider walls split the
  // world into four quadrant arenas, each joined to its two neighbours by a
  // narrow tunnel (a loop TL→TR→BR→BL). The selected map is stamped into every
  // quadrant and `spec.perQuadrant` cycles spawn on a ring inside each, indexed
  // so player id `i` lands in quadrant floor(i / perQuadrant).
  private buildQuadArena(spec: QuadSpec): Spawn[] {
    const B = spec.border; // outer frame thickness (matches startRound's frame)
    const DIV = BORDER; // divider thickness (kept at the base width)
    const TUN = 7; // tunnel half-width: a 2*TUN+1 = 15-cell passage
    // top-left cell of each divider band, centred on the world axes
    const vx0 = Math.floor(this.cols / 2) - Math.floor(DIV / 2);
    const hy0 = Math.floor(this.rows / 2) - Math.floor(DIV / 2);

    // vertical divider (full height) and horizontal divider (full width)
    for (let y = 0; y < this.rows; y++) {
      for (let d = 0; d < DIV; d++) this.grid[this.idx(vx0 + d, y)] = WALL;
    }
    for (let x = 0; x < this.cols; x++) {
      for (let d = 0; d < DIV; d++) this.grid[this.idx(x, hy0 + d)] = WALL;
    }

    // quadrant interiors: [originX, originY, endX, endY) clear of every wall
    const quads = [
      { ox: B, oy: B, ex: vx0, ey: hy0 }, // TL
      { ox: vx0 + DIV, oy: B, ex: this.cols - B, ey: hy0 }, // TR
      { ox: B, oy: hy0 + DIV, ex: vx0, ey: this.rows - B }, // BL
      { ox: vx0 + DIV, oy: hy0 + DIV, ex: this.cols - B, ey: this.rows - B }, // BR
    ];

    // tunnels: carve a gap through each divider so the four arenas form a loop.
    // vertical divider — gaps connect TL↔TR (top) and BL↔BR (bottom)
    const topMidY = Math.floor((B + hy0) / 2);
    const botMidY = Math.floor((hy0 + DIV + this.rows - B) / 2);
    this.carve(vx0, topMidY - TUN, DIV, 2 * TUN + 1);
    this.carve(vx0, botMidY - TUN, DIV, 2 * TUN + 1);
    // horizontal divider — gaps connect TL↔BL (left) and TR↔BR (right)
    const leftMidX = Math.floor((B + vx0) / 2);
    const rightMidX = Math.floor((vx0 + DIV + this.cols - B) / 2);
    this.carve(leftMidX - TUN, hy0, 2 * TUN + 1, DIV);
    this.carve(rightMidX - TUN, hy0, 2 * TUN + 1, DIV);

    const spawns: Spawn[] = [];
    for (let q = 0; q < quads.length; q++) {
      const { ox, oy, ex, ey } = quads[q];
      const qw = ex - ox;
      const qh = ey - oy;
      const qcx = (ox + ex) / 2;
      const qcy = (oy + ey) / 2;

      // stamp the selected map into this quadrant (built at quadrant scale,
      // then offset into place — it stays central, clear of dividers + ring)
      for (const [px, py, w, h] of this.currentMap.build(qw, qh)) {
        this.fillRect(ox + px, oy + py, w, h);
      }

      // Spread the quadrant's cycles across concentric rings (a single ring packs
      // them into one band and leaves the rest empty) — see ringFill.
      for (const sp of this.ringFill(
        spec.perQuadrant,
        qcx,
        qcy,
        Math.min(qw, qh) / 2,
        ox,
        ex - 1,
        oy,
        ey - 1,
      )) {
        spawns.push(sp);
      }
    }
    return spawns;
  }

  // Place `n` cycles spread across several concentric rings filling a disc of max
  // radius `span` centred on (cx,cy), each facing inward, clamped to the given
  // bounds. A single ring packs a big field into one band — or, past its capacity,
  // overlaps cycles onto the same cell — so the ring COUNT grows with the field
  // (~sqrt(n)); each ring takes a share of the cycles proportional to its radius
  // (circumference) and is rotated by the golden angle so neighbouring rings
  // interleave rather than align. Shared by the quad layouts and large classic
  // fields so hundreds of cycles always spawn a safe distance apart.
  private ringFill(
    n: number,
    cx: number,
    cy: number,
    span: number,
    loX: number,
    hiX: number,
    loY: number,
    hiY: number,
  ): Spawn[] {
    const out: Spawn[] = [];
    const rings = Math.max(1, Math.round(Math.sqrt(n / 3)));
    const minR = rings === 1 ? span * 0.4 : span * 0.32;
    const maxR = span * 0.92;
    const radii: number[] = [];
    for (let r = 0; r < rings; r++) {
      radii.push(rings === 1 ? minR : minR + ((maxR - minR) * r) / (rings - 1));
    }
    const weight = radii.reduce((s, r) => s + r, 0);
    // largest-remainder apportionment so the per-ring counts sum to exactly n
    const raw = radii.map((r) => (n * r) / weight);
    const counts = raw.map(Math.floor);
    let left = n - counts.reduce((s, c) => s + c, 0);
    radii
      .map((_, r) => r)
      .sort((a, b) => raw[b] - raw[a] - (counts[b] - counts[a]))
      .forEach((r) => {
        if (left-- > 0) counts[r]++;
      });

    for (let r = 0; r < rings; r++) {
      const offset = r * 2.39996; // golden angle (radians) to stagger rings
      for (let k = 0; k < counts[r]; k++) {
        out.push(
          this.ringSpawn(k, counts[r], cx, cy, radii[r], loX, hiX, loY, hiY, offset),
        );
      }
    }
    return out;
  }

  // One spawn on a ring of `count` points around (cx, cy): slot `i` sits at its
  // angle and radius, clamped inside [loX..hiX] × [loY..hiY], facing the centre.
  private ringSpawn(
    i: number,
    count: number,
    cx: number,
    cy: number,
    radius: number,
    loX: number,
    hiX: number,
    loY: number,
    hiY: number,
    angOffset = 0,
  ): Spawn {
    const ang = (i / count) * Math.PI * 2 - Math.PI / 2 + angOffset;
    let sx = Math.round(cx + Math.cos(ang) * radius);
    let sy = Math.round(cy + Math.sin(ang) * radius);
    sx = Math.max(loX + 1, Math.min(hiX - 1, sx));
    sy = Math.max(loY + 1, Math.min(hiY - 1, sy));
    const dx = cx - sx;
    const dy = cy - sy;
    const dir: Dir =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
    return { x: sx, y: sy, dir };
  }

  // clear a w×h block back to EMPTY (used to punch tunnels through dividers)
  private carve(px: number, py: number, w: number, h: number): void {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        this.grid[this.idx(px + xx, py + yy)] = EMPTY;
      }
    }
  }

  // stamp a w×h block of WALL, clipped to the arena interior
  private fillRect(px: number, py: number, w: number, h: number): void {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        this.grid[this.idx(px + xx, py + yy)] = WALL;
      }
    }
  }

  // a cycle just died at (cx, cy): clear a 5x5 block (trails, pillars, walls,
  // old death marks), then stamp the centre 3x3 as destructible DEATH markers
  // and fire off a 5x5 explosion flash. Outer walls are left intact.
  private placeDeathMark(cx: number, cy: number): void {
    const half = Math.floor(DEATH_BLAST / 2);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        // centre 3x3 becomes black death dots, the surrounding ring is cleared
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
          this.grid[this.idx(x, y)] = DEATH;
        } else {
          this.grid[this.idx(x, y)] = EMPTY;
        }
      }
    }
    // 5x5 explosion flash centred on the death cell (purely visual)
    this.spawnExplosion(cx - half, cy - half, DEATH_BLAST);
  }

  // push an explosion flash whose top-left is (x0, y0) and that spans
  // `size` x `size` cells, and leave a persistent gray scorch over its
  // footprint. The scorch is purely visual and never blocks movement.
  private spawnExplosion(x0: number, y0: number, size: number): void {
    this.explosions.push({ x: x0, y: y0, size, age: 0, life: EXPLOSION_MS });
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        this.scorch[this.idx(x0 + dx, y0 + dy)] = 1;
      }
    }
  }

  // shift a world-pixel coordinate by whole worlds so it sits nearest `ref`;
  // keeps the camera from panning across the whole map when the target wraps
  private nearestWrapPx(v: number, ref: number, world: number): number {
    return v - world * Math.round((v - ref) / world);
  }

  // ---- input -------------------------------------------------------------

  steerHuman(p: Player, dir: Dir): void {
    p.queueTurn(dir);
  }

  tryShoot(p: Player): void {
    if (this.state !== "playing" || !p.alive || !p.charged) return;
    p.charge = 0;
    p.firedThisStep = true; // suppress this step's sprint so we don't shell our own trail
    this.projectiles.push({
      x: p.x,
      y: p.y,
      dir: p.dir,
      owner: p.id,
      color: p.color,
      range: PROJ_RANGE,
      acc: 0,
    });
  }

  // ---- simulation --------------------------------------------------------

  update(dt: number): void {
    if (this.state === "playing") {
      const t0 = performance.now();
      if (this.parallelEngaged()) this.updateParallel(dt);
      else this.updateSerial(dt);
      this.tickMs = performance.now() - t0;
    }

    this.updateCameras(dt);
  }

  // Whether the parallel path is actually driving the sim right now (for the HUD).
  get parallelLive(): boolean {
    return this.state === "playing" && this.parallelEngaged();
  }

  // True when the parallel AI path is usable this frame: the worker pool is up and
  // parked, the shared buffers match the current match, our grid IS the shared SAB
  // grid, and the field is big enough to be worth fanning out (same threshold that
  // gates staggering). Otherwise we run the proven single-threaded path.
  private parallelEngaged(): boolean {
    const par = this.parallel;
    return (
      par !== null &&
      par.isReady() &&
      par.world !== null &&
      this.grid === par.world.grid &&
      this.players.length >= AI_STAGGER_MIN_CYCLES
    );
  }

  // The original single-threaded simulation step (unchanged behaviour). Also the
  // fallback whenever the parallel path is unavailable.
  private updateSerial(dt: number): void {
    // bucket cycles into the spatial grid once per frame; every nearestRival
    // query this frame (steering + shooting) reads it instead of scanning all
    this.rebuildSpatial();
    for (const p of this.players) {
      if (!p.alive) continue;
      p.charge = Math.min(CHARGE_MAX, p.charge + dt * CHARGE_RATE);
      p.acc += dt;
      let steps = 0;
      while (p.acc >= p.interval && steps < 2) {
        p.acc -= p.interval;
        this.stepPlayer(p);
        steps++;
        if (!p.alive) break;
      }
    }

    this.updateProjectiles(dt);
    this.checkRoundOver();
  }

  private checkRoundOver(): void {
    const survival = this.players.length === 1;
    if ((!survival && this.aliveCount <= 1) || (survival && this.aliveCount === 0)) {
      // round's over — the (at most one) survivor is needed only here, so find
      // it now rather than allocating a filtered array every tick
      this.endRound(this.players.find((p) => p.alive) ?? null);
    }
  }

  private stepPlayer(p: Player): void {
    if (p.type === "ai") {
      this.aiThink(p);
      if (p.escapeSteps > 0) p.escapeSteps--;
    } else {
      p.applyNextTurn();
    }
    this.applyMoveStep(p);
  }

  // Advance a cycle one cell in its current heading: die on a collision (leaving a
  // death mark), otherwise lay trail and move. Shared by the serial step and the
  // parallel apply phase so movement/collision rules stay identical.
  private applyMoveStep(p: Player): void {
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;

    if (!this.isFree(nx, ny)) {
      p.alive = false;
      this.aliveCount--;
      this.placeDeathMark(p.x, p.y);
      return;
    }

    // wrap onto the torus so the stored head position is always in-grid
    p.x = this.wrapX(nx);
    p.y = this.wrapY(ny);
    p.length++;
    this.grid[this.idx(p.x, p.y)] = p.id;
    this.dirs[this.idx(p.x, p.y)] = p.dir;
  }

  // Parallel simulation step: identical accounting to updateSerial, but the heavy
  // per-cycle steering scan is fanned out across worker threads. Within a frame a
  // cycle may step up to twice (sprint); we process in ROUNDS — all due cycles
  // think (in parallel) then move (serially, in id order) — so sprinting cycles
  // re-plan on the fresh grid for their second step. Bots plan on the start-of-
  // round grid (they don't see each other's same-round moves); a ~1-cell staleness
  // that's the standard price of parallelism.
  private updateParallel(dt: number): void {
    const par = this.parallel!;
    const world = par.world!;
    const players = this.players;

    for (const p of players) {
      if (!p.alive) continue;
      p.charge = Math.min(CHARGE_MAX, p.charge + dt * CHARGE_RATE);
      p.acc += dt;
      this.stepsTaken[p.id] = 0;
    }

    for (let round = 0; round < 2; round++) {
      // gather cycles due to step this round (alive, enough accumulated time, and
      // under the 2-step/frame cap)
      let anyDue = false;
      let dueAi = 0;
      const dueList = par.dueList!;
      for (const p of players) {
        if (p.alive && this.stepsTaken[p.id] < 2 && p.acc >= p.interval) {
          anyDue = true;
          if (p.type === "ai") dueList[dueAi++] = p.id;
        }
      }
      if (!anyDue) break;

      // snapshot the roster + rebuild the spatial grid into the shared buffers so
      // workers see this round's positions, then fan out the steering scan
      this.snapshotWorld(world);
      par.think(dueAi);

      // apply serially in id order: read back each AI cycle's chosen heading, run
      // its (state-mutating) shooting/sprint on the main thread, then move it
      for (const p of players) {
        if (!(p.alive && this.stepsTaken[p.id] < 2 && p.acc >= p.interval)) continue;
        p.acc -= p.interval;
        if (p.type === "ai") {
          p.dir = world.pdir[p.id] as Dir;
          p.aiCooldown = world.paiCooldown[p.id];
          this.aiEscapePlan(p); // route-out override when boxed (turtle); no-op otherwise
          this.aiAvoidDanger(p);
          this.aiMaybeShoot(p);
          this.aiSprint(p);
          if (p.escapeSteps > 0) p.escapeSteps--;
        } else {
          p.applyNextTurn();
        }
        this.applyMoveStep(p);
        this.stepsTaken[p.id]++;
      }
    }

    this.updateProjectiles(dt);
    this.checkRoundOver();
  }

  // Mirror live Player state + the spatial grid into the shared world buffers the
  // workers read. The big grid is already the shared SAB (no copy); only the small
  // O(n) per-cycle arrays + the CSR spatial grid are written here each round.
  private snapshotWorld(world: SteerWorld): void {
    this.rebuildSpatial();
    world.tileStart.set(this.tileStart);
    world.tileItems.set(this.tileItems.subarray(0, this.players.length));
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      world.px[i] = p.x;
      world.py[i] = p.y;
      world.pdir[i] = p.dir;
      world.palive[i] = p.alive ? 1 : 0;
      world.pcharged[i] = p.charged ? 1 : 0;
      world.pescapeSteps[i] = p.escapeSteps;
      world.paiCooldown[i] = p.aiCooldown;
    }
  }

  private updateProjectiles(dt: number): void {
    if (this.projectiles.length > 0) {
      // compact survivors in place (write cursor w never outruns read cursor r,
      // so no live entry is clobbered) instead of allocating a fresh array each
      // frame — same survivors, same order, zero per-frame garbage.
      const projectiles = this.projectiles;
      let w = 0;
      for (let r = 0; r < projectiles.length; r++) {
        const pr = projectiles[r];
        pr.acc += dt;
        let live = true;
        let steps = 0;
        const firer = this.players[pr.owner];
        while (live && pr.acc >= PROJ_INTERVAL && steps < 8) {
          pr.acc -= PROJ_INTERVAL;
          steps++;
          const nx = this.wrapX(pr.x + DELTA[pr.dir].x);
          const ny = this.wrapY(pr.y + DELTA[pr.dir].y);
          const g = this.grid[this.idx(nx, ny)];
          // Explode on the first obstacle hit — wall, pillar, death mark, or any
          // cycle's trail (including the firer's own). Nothing is tunnelled. The
          // sole exception is the one cell the firer currently occupies: a rocket
          // is born on the firer's head and the firer keeps laying trail there as
          // it advances, so without this the shot would detonate on yourself the
          // instant it left the barrel. The rocket outruns the cycle, so it slips
          // past that single live-head cell and then treats everything as solid.
          const onFirerHead =
            firer && firer.alive && nx === firer.x && ny === firer.y;
          if (g !== EMPTY && !onFirerHead) {
            this.detonate(nx, ny, pr.owner);
            live = false;
            break;
          }
          pr.x = nx;
          pr.y = ny;
          pr.range--;
          if (pr.range <= 0) {
            this.detonate(pr.x, pr.y, pr.owner);
            live = false;
          }
        }
        if (live) projectiles[w++] = pr;
      }
      projectiles.length = w;
    }

    if (this.explosions.length > 0) {
      // age + drop expired in a single in-place compaction pass (no .filter alloc)
      const explosions = this.explosions;
      let w = 0;
      for (let r = 0; r < explosions.length; r++) {
        const e = explosions[r];
        e.age += dt;
        if (e.age < e.life) explosions[w++] = e;
      }
      explosions.length = w;
    }
  }

  // BLAST x BLAST blast centred near (cx,cy): clears trails + interior pillars
  // and kills any rival caught inside. Outer walls and the firer are spared.
  private detonate(cx: number, cy: number, owner?: number): void {
    // the cycle whose rocket this was — credited with destroyed blocks and any
    // rival kills (undefined when a blast has no firer)
    const firer = owner !== undefined ? this.players[owner] : undefined;
    const x0 = cx - Math.floor(BLAST / 2);
    const y0 = cy - Math.floor(BLAST / 2);
    for (let dy = 0; dy < BLAST; dy++) {
      for (let dx = 0; dx < BLAST; dx++) {
        const i = this.idx(x0 + dx, y0 + dy);
        const g = this.grid[i];
        // every solid cell the blast clears — a light trail (g >= 0), a border /
        // divider wall, or a death mark — counts as a destroyed block for the
        // firer's tally. (Trails are by far the most common, which is why a
        // WALL-only count read 0 in normal play.)
        if (g >= 0 || g === WALL || g === DEATH) {
          if (firer) firer.blocksDestroyed++;
          this.grid[i] = EMPTY;
        }
      }
    }
    // Kill scan: instead of testing the whole roster (O(N) per detonation — brutal
    // when many bots are trading fire), query only the spatial-grid tiles overlapping
    // the blast. The grid was rebuilt at the top of this frame and cycles have since
    // stepped at most 2 cells, so we pad the queried box by that MARGIN to be sure a
    // cycle that moved INTO the blast is never missed. Each candidate is still re-tested
    // against the exact torus blast box (extra candidates from tile granularity are
    // harmless), and the kill is idempotent (the !p.alive guard), so a tile revisited
    // via torus wrap on a tiny grid can't double-count. Same kills as the old scan.
    const players = this.players;
    const tilesX = this.tilesX;
    const tilesY = this.tilesY;
    const tStart = this.tileStart;
    const tItems = this.tileItems;
    const MARGIN = 2; // cycles step up to 2 cells/frame after the spatial rebuild
    const span = BLAST - 1 + 2 * MARGIN; // cells the padded box covers per axis
    const t0x = Math.floor((x0 - MARGIN) / SPATIAL_TILE);
    const t0y = Math.floor((y0 - MARGIN) / SPATIAL_TILE);
    const ntx = Math.min(tilesX, Math.floor((x0 - MARGIN + span) / SPATIAL_TILE) - t0x + 1);
    const nty = Math.min(tilesY, Math.floor((y0 - MARGIN + span) / SPATIAL_TILE) - t0y + 1);
    for (let iy = 0; iy < nty; iy++) {
      const ty = (((t0y + iy) % tilesY) + tilesY) % tilesY;
      for (let ix = 0; ix < ntx; ix++) {
        const tx = (((t0x + ix) % tilesX) + tilesX) % tilesX;
        const t = ty * tilesX + tx;
        const e = tStart[t + 1];
        for (let k = tStart[t]; k < e; k++) {
          const p = players[tItems[k]];
          // the firer is NOT spared — caught in your own blast (shooting a wall or
          // rival point-blank) kills you too. The rocket still can't detonate on the
          // firer's own live-head cell at launch (see updateProjectiles), so a normal
          // shot flies clear; it's only a too-close detonation that catches you.
          if (!p.alive) continue;
          // torus-aware hit test: wrapped offset of the cycle from the blast corner
          const ddx = this.wrapX(p.x - x0);
          const ddy = this.wrapY(p.y - y0);
          if (ddx < BLAST && ddy < BLAST) {
            p.alive = false;
            this.aliveCount--;
            // credit the firer with a kill — but only for downing a rival; being
            // caught in your own blast is a self-kill and doesn't count.
            if (firer && p !== firer) firer.kills++;
            this.placeDeathMark(p.x, p.y);
          }
        }
      }
    }
    this.spawnExplosion(x0, y0, BLAST);
  }

  // True while at least one human pilot is still racing. Used to gate the
  // bail-out: a downed human can only call the round when no human is left
  // alive, so one dead player can't cut a still-racing teammate's round short.
  humansAlive(): boolean {
    return this.players.some((p) => p.type === "human" && p.alive);
  }

  // A downed human ends the round immediately instead of waiting for the bots
  // to fight it out. No winner is crowned — the match is simply called, and the
  // results screen notes it was ended early.
  endRoundEarly(): void {
    if (this.state !== "playing" || this.humansAlive()) return;
    this.endedEarly = true;
    this.endRound(null);
  }

  private endRound(winner: Player | null): void {
    this.state = "roundover";
    this.winner = winner;
    if (winner) {
      winner.wins++;
      this.winnerName = winner.name;
    } else {
      this.winnerName = null;
    }
    this.cb.onRoundOver(this);
  }

  // ---- AI ----------------------------------------------------------------

  // Turn a roster spec into a per-bot list of characters of length `n` (the bot
  // count, which the quad modes fix and classic takes from the menu). Returns a
  // shuffled list so spawn order / quadrants get a spread rather than clumps.
  private resolveRoster(roster: AiRoster | undefined, n: number): Personality[] {
    const out: Personality[] = [];

    // uniform / unspecified: every bot is the one character (default balanced)
    if (!roster || roster.mode === "uniform") {
      const p = roster?.personality ?? "balanced";
      for (let i = 0; i < n; i++) out.push(p);
      return out;
    }

    // random: each bot draws from the chosen pool (empty pool = every character)
    if (roster.mode === "random") {
      const pool = roster.pool.length ? roster.pool : ALL_PERSONALITIES;
      for (let i = 0; i < n; i++) {
        out.push(pool[Math.floor(Math.random() * pool.length)]);
      }
      return this.shuffle(out);
    }

    // counts: explicit number of each character. In classic mode `n` already
    // equals the requested total; in quad modes (n fixed by the grid) we scale
    // the counts proportionally to fill exactly n slots.
    const entries = (Object.entries(roster.counts) as [Personality, number][])
      .filter(([, c]) => c > 0);
    const spec = entries.reduce((s, [, c]) => s + c, 0);
    if (spec === 0) {
      for (let i = 0; i < n; i++) out.push("balanced");
      return out;
    }
    for (const [p, c] of entries) {
      const k = spec === n ? c : Math.round((c / spec) * n);
      for (let i = 0; i < k && out.length < n; i++) out.push(p);
    }
    // rounding can leave us a couple short or over — pad by cycling the chosen
    // characters, then trim to exactly n
    for (let i = 0; out.length < n; i++) out.push(entries[i % entries.length][0]);
    out.length = n;
    return this.shuffle(out);
  }

  // in-place Fisher–Yates shuffle
  private shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // One AI step, with staggered planning. The expensive part is aiChoose (the
  // steering scan); shooting and sprint decisions are cheap and run every step.
  // We re-run aiChoose only when the bot's plan has expired (aiCooldown hit 0) or
  // when the cell straight ahead is no longer clear — so a coasting bot still
  // reacts instantly to a wall appearing in front of it and never crashes "blind".
  // While bursting through an escape hole (escapeSteps > 0) we always replan: that
  // path is cheap (aiChoose short-circuits) and must not be skipped.
  private aiThink(p: Player): void {
    // Coast on the existing plan only when ALL of these hold: staggering is active
    // (big field), the plan hasn't expired, we're not mid-escape, and the bot is
    // cruising clearly open arena (long runway ahead + open surroundings). The
    // instant it's anywhere near tight space we fall through to a full aiChoose —
    // that's exactly where the deep look-ahead earns its cost, so trap-avoidance is
    // preserved; we only skip the scan where steering is trivial. In small fields
    // (below the threshold) we never coast, so the AI is bit-for-bit the original.
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;
    // The turtle opts out of coasting entirely (noCoast): it spends the extra CPU
    // to re-plan every step so its vigilance never lapses.
    const canCoast =
      !p.aiProfile?.noCoast &&
      this.players.length >= AI_STAGGER_MIN_CYCLES &&
      p.aiCooldown > 0 &&
      p.escapeSteps === 0 &&
      this.clearAhead(p, COAST_RUNWAY) >= COAST_RUNWAY &&
      this.openness(nx, ny, OPEN_RADIUS) >= COAST_OPEN_MIN;
    if (canCoast) {
      p.aiCooldown--; // cruising open space — reuse the last heading
    } else {
      p.dir = this.aiChoose(p);
      p.aiCooldown = AI_THINK_PERIOD;
    }
    this.aiEscapePlan(p); // route-out override when boxed (turtle); no-op otherwise
    this.aiAvoidDanger(p);
    this.aiMaybeShoot(p);
    this.aiSprint(p);
  }

  private aiChoose(p: Player): Dir {
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    const cur = p.dir;
    const back = opposite(cur);

    // Breaking out: just blasted a hole, so commit to driving straight through
    // it instead of letting the scorer curl us back along the wall (which is how
    // the spiral re-forms). Require TWO clear cells ahead, not one: the bot
    // sprints through an escape (up to 2 cells per step), so a single-cell check
    // would keep committing straight until it slammed into the wall behind the
    // blasted hole. The moment that far wall is within a sprint-step we abandon
    // the straight commit and fall through to full steering while a turn is still
    // available — which is what stops the "punch through the hole, ram the wall
    // behind it" self-kill.
    if (p.escapeSteps > 0 && this.clearAhead(p, 2) >= 2) {
      return cur;
    }

    // when armed, pick a rival to hunt this step so the steering can line up a
    // shot on it (see aimBonus). Disarmed bots just drive for space — except
    // stalkers (the ambusher), which shadow the nearest rival even unarmed.
    const target =
      cfg.hunt > 0 && (p.charged || cfg.stalk)
        ? this.nearestRival(p, cfg.seekRange ?? cfg.aimRange)
        : null;

    // The turtle's avoidance target: the nearest rival to actively FLEE from.
    // Separate from `target` (which is for hunting) — a turtle has hunt 0 so it
    // never hunts, but a positive `avoid` makes it steer to widen the gap. Looked
    // up from a wide avoidRange so it reacts to a rival well before it's close.
    const avoidTarget = cfg.avoid
      ? this.nearestRival(p, cfg.avoidRange ?? cfg.seekRange ?? cfg.aimRange)
      : null;

    // Pathfinder: for a hunter with a target in range, the first step of the
    // breach-aware shortest path to it. We follow this instead of steering
    // greedily so the bot routes around obstacles (or bores straight through a
    // wall when that's the cheapest way) rather than getting stuck circling.
    // null when there's no target, it's too far to bother, or no route was found.
    const pathDir =
      cfg.pathfind && target && this.manhattan(p, target) <= PF_RANGE
        ? this.pathToward(p, target)
        : null;

    let bestDir = cur;
    let bestScore = -Infinity;

    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if (d === back) continue;
      const nx = p.x + DELTA[d].x;
      const ny = p.y + DELTA[d].y;
      if (!this.isFree(nx, ny)) continue;

      const flood = this.floodCount(nx, ny, cfg.flood);
      let score = flood;
      // Path following — take the computed route's first step. The bonus is huge
      // (it dominates the greedy terms), but we only grant it when the cell isn't
      // an immediate trap, so survival still wins over a bad route. When the path
      // points into a wall (the cheapest way is through it) no free dir matches,
      // so the bot falls back to survival steering and mills near the wall while
      // its rockets grind it open — exactly the breach-and-retry we want.
      if (pathDir !== null && d === pathDir && flood >= PF_MIN_FLOOD) {
        score += PF_PATH_BONUS;
      }
      // Openness gradient — the anti-spiral term. The flood area saturates its
      // cap while the pocket is still large, so on its own it can't tell "open
      // arena" from "the inside of my own tightening coil". Counting nearby free
      // cells can: the coil's interior is walled by our trail on every side, so
      // it scores far lower than the open side and we steer out instead of in.
      score += this.openness(nx, ny, OPEN_RADIUS) * cfg.open;
      // Hunting — close on the chosen rival and, better still, swing onto its
      // row/column so the next aiMaybeShoot has a clean firing line. Only a nudge:
      // it competes with the survival terms, so a bot won't dive into a wall to
      // chase. Crucially, we withhold the hunt bonus entirely when the cell floods
      // to less than HUNT_MIN_FLOOD room — chasing into a near-trap is the #1 way a
      // hunter boxes itself in a crowd, so below that it steers on survival alone.
      if (target && flood >= HUNT_MIN_FLOOD) {
        score += this.aimBonus(p, d, target) * cfg.hunt;
      }
      // Avoidance — the inverse of the hunt term. Subtracting aimBonus rewards
      // moves that open distance to the rival and penalises closing on it or
      // swinging onto its row/column (its firing line). A secondary nudge: it
      // competes with openness and is dwarfed by the flood term, so the turtle
      // peels away from rivals but never flees into a trap to do it.
      if (avoidTarget && cfg.avoid) {
        score -= this.aimBonus(p, d, avoidTarget) * cfg.avoid;
      }
      if (d === cur) score += cfg.straight; // prefer straight lines
      score += Math.random() * cfg.jitter;

      if (score > bestScore) {
        bestScore = score;
        bestDir = d;
      }
    }
    return bestDir;
  }

  // (Re)size the spatial bucket grid to the current world + roster. Cheap no-op
  // when nothing changed, so it's safe to call every frame before rebuildSpatial.
  private ensureSpatial(): void {
    const tx = Math.max(1, Math.ceil(this.cols / SPATIAL_TILE));
    const ty = Math.max(1, Math.ceil(this.rows / SPATIAL_TILE));
    if (tx !== this.tilesX || ty !== this.tilesY) {
      this.tilesX = tx;
      this.tilesY = ty;
      this.tileStart = new Int32Array(tx * ty + 1);
      this.tileCursor = new Int32Array(tx * ty);
    }
    if (this.tileItems.length < this.players.length) {
      this.tileItems = new Int32Array(this.players.length);
    }
  }

  // Bucket every living cycle into its tile via a counting sort (CSR), so a
  // nearestRival query can walk just the tiles near the asker. O(tiles + cycles).
  private rebuildSpatial(): void {
    this.ensureSpatial();
    const tx = this.tilesX;
    const nt = tx * this.tilesY;
    const start = this.tileStart;
    const cursor = this.tileCursor;
    const items = this.tileItems;
    const players = this.players;

    start.fill(0);
    // count per tile (offset by 1 so we can prefix-sum straight into start)
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const t = ((p.y / SPATIAL_TILE) | 0) * tx + ((p.x / SPATIAL_TILE) | 0);
      start[t + 1]++;
    }
    for (let t = 0; t < nt; t++) start[t + 1] += start[t];
    for (let t = 0; t < nt; t++) cursor[t] = start[t];
    // scatter player indices into their tile's slice, and (large fields only) stamp
    // each head into the head map for O(1) firing-line rival lookup
    const buildHeads = players.length >= AI_STAGGER_MIN_CYCLES;
    const hgen = buildHeads ? ++this.headGen : 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const t = ((p.y / SPATIAL_TILE) | 0) * tx + ((p.x / SPATIAL_TILE) | 0);
      items[cursor[t]++] = i;
      if (buildHeads) {
        const c = p.y * this.cols + p.x; // heads are always in-grid (wrapped)
        this.headStamp[c] = hgen;
        this.headOwner[c] = p.id;
      }
    }
  }

  // Nearest living rival within `range` (toroidal Manhattan distance), or null.
  // Walks the spatial grid in tile-rings outward from the asker and stops one ring
  // past the first hit — so it touches only nearby cycles instead of the whole
  // field, at the cost of being "nearest up to ~one tile of slack" (fine for the
  // heuristic targeting that consumes it). Falls back to exact when the grid is a
  // single tile (tiny arenas).
  private nearestRival(p: Player, range: number): Player | null {
    const tx = this.tilesX;
    const ty = this.tilesY;
    const players = this.players;
    const start = this.tileStart;
    const items = this.tileItems;
    const ptx = (p.x / SPATIAL_TILE) | 0;
    const pty = (p.y / SPATIAL_TILE) | 0;
    // Cap the outward search: a rival within Manhattan `range` can't be more than
    // ceil(range/TILE)+1 tile-rings away, and tiles wrap so half the grid covers
    // the whole torus. Without the range cap, a bot with no rival in reach would
    // pointlessly scan every tile — worse than the old full-roster scan.
    const maxR = Math.min(
      Math.ceil(Math.max(tx, ty) / 2),
      Math.ceil(range / SPATIAL_TILE) + 1,
    );

    let best: Player | null = null;
    let bestD = range + 1;
    let foundRing = -1;

    for (let r = 0; r <= maxR; r++) {
      // stop one ring after the first hit — a closer rival can't hide further out
      // than that by more than a tile's worth of slack
      if (foundRing >= 0 && r > foundRing + 1) break;
      for (let dy = -r; dy <= r; dy++) {
        const edgeY = dy === -r || dy === r;
        for (let dx = -r; dx <= r; dx++) {
          // only the perimeter of the (2r+1) box is new this ring
          if (!edgeY && dx !== -r && dx !== r) continue;
          const cx = (((ptx + dx) % tx) + tx) % tx;
          const cy = (((pty + dy) % ty) + ty) % ty;
          const t = cy * tx + cx;
          const e = start[t + 1];
          for (let k = start[t]; k < e; k++) {
            const q = players[items[k]];
            // buckets are a frame-start snapshot; a rival may have died earlier
            // this same frame, so still guard against targeting a corpse
            if (!q.alive || q.id === p.id) continue;
            const qdx = Math.abs(this.wrapDelta(q.x - p.x, this.cols));
            const qdy = Math.abs(this.wrapDelta(q.y - p.y, this.rows));
            const d = qdx + qdy;
            if (d < bestD) {
              bestD = d;
              best = q;
            }
          }
        }
      }
      if (best && foundRing < 0) foundRing = r;
    }
    return best;
  }

  // Toroidal Manhattan distance between two cycles.
  private manhattan(a: Player, b: Player): number {
    return (
      Math.abs(this.wrapDelta(b.x - a.x, this.cols)) +
      Math.abs(this.wrapDelta(b.y - a.y, this.rows))
    );
  }

  // Toroidal Chebyshev (chessboard) distance between two cells. Used to test
  // whether a cell falls inside the 3x3 death block a dying cycle leaves behind
  // (footprint radius 1), so the hunter can keep clear of it (see aiAvoidDanger).
  private chebyshev(ax: number, ay: number, bx: number, by: number): number {
    return Math.max(
      Math.abs(this.wrapDelta(bx - ax, this.cols)),
      Math.abs(this.wrapDelta(by - ay, this.rows)),
    );
  }

  // Breach-aware shortest path: the cheapest route from `p` to `t`, where moving
  // through a free cell costs 1 and through a breakable wall/trail costs
  // PF_WALL_COST. Returns the FIRST step's direction, or null if `t` wasn't
  // reached within the PF_NODES budget. Walls aren't avoided outright — if the
  // easiest way to the rival is straight through a thick wall, the path points
  // into it and the hunter's rockets do the rest.
  //
  // Implemented as a Dijkstra expanding outward FROM the target, storing at every
  // cell the direction that steps back toward the target; we read that direction
  // at the hunter's cell once it's settled. A binary min-heap orders the frontier;
  // the stamp/gen trick avoids clearing the grid-sized arrays each call.
  private pathToward(p: Player, t: Player): Dir | null {
    const n = this.cols * this.rows;
    if (!this.pfDist || this.pfDist.length !== n) {
      this.pfDist = new Float64Array(n);
      this.pfStamp = new Int32Array(n);
      this.pfNext = new Int8Array(n);
      this.pfHeap = new Float64Array(1 << 16);
    }
    const dist = this.pfDist;
    const stamp = this.pfStamp!;
    const next = this.pfNext!;
    const heap = this.pfHeap!;
    const HMAX = heap.length;
    const gen = ++this.pfGen;

    // heap entries encode (cost, cell) as cost*n + cell so a single numeric
    // compare orders by cost; cell is recovered with % n.
    let hlen = 0;
    const push = (key: number): void => {
      if (hlen >= HMAX) return; // budget guard: drop overflow (path may be suboptimal)
      let i = hlen++;
      heap[i] = key;
      while (i > 0) {
        const par = (i - 1) >> 1;
        if (heap[par] <= heap[i]) break;
        const tmp = heap[par];
        heap[par] = heap[i];
        heap[i] = tmp;
        i = par;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap[--hlen];
      if (hlen > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < hlen && heap[l] < heap[s]) s = l;
          if (r < hlen && heap[r] < heap[s]) s = r;
          if (s === i) break;
          const tmp = heap[s];
          heap[s] = heap[i];
          heap[i] = tmp;
          i = s;
        }
      }
      return top;
    };

    const src = this.idx(t.x, t.y);
    const goal = this.idx(p.x, p.y);
    dist[src] = 0;
    stamp[src] = gen;
    push(src); // key = 0 * n + src

    let pops = 0;
    let reached = false;
    while (hlen > 0 && pops < PF_NODES) {
      const key = pop();
      const cell = key % n;
      const cost = (key - cell) / n;
      if (stamp[cell] === gen && dist[cell] < cost) continue; // stale heap entry
      if (cell === goal) {
        reached = true;
        break;
      }
      pops++;
      const cx = cell % this.cols;
      const cy = (cell - cx) / this.cols;
      // cost the hunter pays to ENTER `cell` (and thus to traverse it on the way
      // toward the target): cheap if open, expensive if it must be blasted.
      const w = this.grid[cell] === EMPTY ? 1 : PF_WALL_COST;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const nx = this.wrapX(cx + DELTA[d].x);
        const ny = this.wrapY(cy + DELTA[d].y);
        const nc = this.idx(nx, ny);
        // Near-impassable penalty for entering a wall that begins a run of MORE
        // than PF_MAX_WALL_RUN consecutive walls in the hunter's travel direction
        // (opposite(d): we expand FROM the target, so the hunter at nc heads back
        // toward `cell`). Any finite go-around then beats boring through, so the
        // hunter routes around thick barriers and digs only when forced.
        const extra =
          this.grid[nc] !== EMPTY &&
          this.wallRunAhead(nx, ny, opposite(d)) > PF_MAX_WALL_RUN
            ? PF_WALL_RUN_PENALTY
            : 0;
        const nd = cost + w + extra;
        if (stamp[nc] !== gen || nd < dist[nc]) {
          stamp[nc] = gen;
          dist[nc] = nd;
          // from neighbour nc, the step toward `cell` (toward the target) is the
          // reverse of the d we used to reach nc from cell.
          next[nc] = opposite(d);
          push(nd * n + nc);
        }
      }
    }

    if (!reached && stamp[goal] !== gen) return null;
    return next[goal] as Dir;
  }

  // Steering reward for moving in `d` when hunting `t`: positive for closing the
  // gap, with a bigger payoff for a move that lands us heading straight down the
  // target's row or column (a firing line). Negative for moving away.
  private aimBonus(p: Player, d: Dir, t: Player): number {
    const dx = this.wrapDelta(t.x - p.x, this.cols);
    const dy = this.wrapDelta(t.y - p.y, this.rows);
    const v = DELTA[d];
    let b = v.x * Math.sign(dx) + v.y * Math.sign(dy); // -1 away, +1 toward
    // already share the target's column: reward facing along it (vertical), and
    // likewise for a shared row (horizontal) — that's the actual shot.
    if (dx === 0 && (d === (dy > 0 ? 2 : 0))) b += 3;
    if (dy === 0 && (d === (dx > 0 ? 1 : 3))) b += 3;
    return b;
  }

  // Signed shortest delta on a wrapped axis of length `n` (e.g. -3 rather than
  // n-3), so direction maths works across the torus seam.
  private wrapDelta(d: number, n: number): number {
    let m = ((d % n) + n) % n;
    if (m > n / 2) m -= n;
    return m;
  }

  // Free cells in a (2r+1)^2 box centred on (cx, cy): a cheap local measure of
  // how boxed-in a move is. Used as the openness steering term (see aiChoose).
  // Hot path: wrap with a single branch per axis instead of idx()'s double
  // modulo, and index the grid directly. |dx|,|dy| <= r << cols/rows, and cx/cy
  // are near in-grid, so one add/sub always lands back in range.
  private openness(cx: number, cy: number, r: number): number {
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;
    let free = 0;
    for (let dy = -r; dy <= r; dy++) {
      let yy = cy + dy;
      if (yy < 0) yy += rows;
      else if (yy >= rows) yy -= rows;
      const row = yy * cols;
      for (let dx = -r; dx <= r; dx++) {
        let xx = cx + dx;
        if (xx < 0) xx += cols;
        else if (xx >= cols) xx -= cols;
        if (grid[row + xx] === EMPTY) free++;
      }
    }
    return free;
  }

  // Clear cells straight ahead, capped at `cap` (early-out measure of runway).
  private clearAhead(p: Player, cap: number): number {
    const dx = DELTA[p.dir].x;
    const dy = DELTA[p.dir].y;
    for (let i = 1; i <= cap; i++) {
      if (!this.isFree(p.x + dx * i, p.y + dy * i)) return i - 1;
    }
    return cap;
  }

  // Length of the contiguous run of breakable (non-EMPTY) cells starting at (x,y)
  // heading `d`, capped at PF_MAX_WALL_RUN + 1 (we only care whether it exceeds
  // the cap). Used by pathToward to make a route crossing more than that many
  // consecutive walls near-impassable, so the hunter routes around a thick barrier
  // instead of boring straight through it. MUST stay identical to steer.ts's copy.
  private wallRunAhead(x: number, y: number, d: Dir): number {
    let run = 0;
    for (let k = 0; k <= PF_MAX_WALL_RUN; k++) {
      if (this.grid[this.idx(x + DELTA[d].x * k, y + DELTA[d].y * k)] === EMPTY) break;
      run++;
    }
    return run;
  }

  // Decide whether the bot sprints this step. Two cases worth the extra speed:
  //   • bursting through a freshly blasted escape hole (get clear before it
  //     closes), and
  //   • a long, clear straightaway with no rival to dodge.
  // Otherwise cruise at base speed — in tight quarters a doubled step gives less
  // room to react to a wall.
  private aiSprint(p: Player): void {
    // Just fired this step: never sprint. A sprinted step advances two cells and
    // lays trail in the very cell the freshly-launched rocket must pass through,
    // so the rocket detonates point-blank on that own trail and kills the firer
    // (see Player.firedThisStep). One cell keeps the rocket on the collision-exempt
    // head until it outruns us. This was THE dominant hunter self-kill: it always
    // sprints AND fires forward escape/breach shots constantly.
    if (p.firedThisStep) {
      p.firedThisStep = false;
      p.sprint = false;
      return;
    }
    // Some profiles (cheating, plus the runner/demolisher characters) run flat
    // out at all times; everyone else only sprints through an escape hole or down
    // a long, clear straightaway.
    if (p.aiProfile?.alwaysSprint || p.escapeSteps > 0) {
      p.sprint = true;
      return;
    }
    p.sprint = this.clearAhead(p, SPRINT_RUNWAY) >= SPRINT_RUNWAY;
  }

  // Walk a straight shot (a rocket, or where an armed rival's rocket WOULD go)
  // from (ox,oy) along `dir` and return how many cells out it first enters our
  // lethal zone — or -1 if it hits something solid (detonates short) or never
  // reaches us within `horizon`. The blast is BLAST x BLAST, so any cell within
  // BLAST_RADIUS of our head (Chebyshev, torus-aware) is a kill; one cell of slack
  // is added so the bot starts breaking out a step early. Mirrors updateProjectiles'
  // detonation rule: the line dies on the first non-empty cell.
  private shotReach(p: Player, ox: number, oy: number, dir: Dir, horizon: number): number {
    const reach = BLAST_RADIUS + 1; // lethal radius (2) + one cell of reaction slack
    const dx = DELTA[dir].x;
    const dy = DELTA[dir].y;
    let cx = ox;
    let cy = oy;
    for (let i = 1; i <= horizon; i++) {
      cx = this.wrapX(cx + dx);
      cy = this.wrapY(cy + dy);
      const ddx = Math.abs(this.wrapDelta(cx - p.x, this.cols));
      const ddy = Math.abs(this.wrapDelta(cy - p.y, this.rows));
      if (Math.max(ddx, ddy) <= reach) return i;
      if (this.grid[this.idx(cx, cy)] !== EMPTY) return -1; // detonates short of us
    }
    return -1;
  }

  // The heading to break toward to clear a shot fired from (ox,oy) along `dir`:
  // perpendicular to the line, toward whichever side we're already off it (the
  // shorter hop out). Dead-centre defaults one way; aiAvoidDanger falls back to
  // the opposite side if that one's walled.
  private breakDir(p: Player, ox: number, oy: number, dir: Dir): Dir {
    if (DELTA[dir].x !== 0) {
      return (this.wrapDelta(p.y - oy, this.rows) >= 0 ? 2 : 0) as Dir; // down / up
    }
    return (this.wrapDelta(p.x - ox, this.cols) >= 0 ? 1 : 3) as Dir; // right / left
  }

  // The heading `p` should break toward to escape the most imminent threat, or
  // null when it's safe. Two threats, nearest wins:
  //   A) a live enemy rocket already in the air bearing down on us, and
  //   B) an armed rival that has us lined up on its heading within DODGE_PREDICT —
  //      we step off the line BEFORE it fires, since a point-blank rocket flies
  //      far too fast to outrun once launched (this is what stops two hunters from
  //      charging muzzle-to-muzzle and trading kills).
  private dodgeDir(p: Player): Dir | null {
    let escape: Dir | null = null;
    let bestSteps = Infinity;

    // A) rockets in flight
    for (const pr of this.projectiles) {
      if (pr.owner === p.id) continue; // our own rocket is no threat to us
      const s = this.shotReach(p, pr.x, pr.y, pr.dir, Math.min(DODGE_HORIZON, pr.range));
      if (s >= 0 && s < bestSteps) {
        bestSteps = s;
        escape = this.breakDir(p, pr.x, pr.y, pr.dir);
      }
    }

    // B) a rival drawing a bead on us — dodge the shot before it's taken. A
    // charged rival is an immediate threat; a fellow DODGE-capable rival (another
    // hunter) counts even while recharging, because it WILL re-arm and we don't
    // want to be sitting on its line when it does — this keeps two hunters from
    // lining each other up at all, the other half of the no-mutual-kill behaviour.
    const foe = this.nearestRival(p, DODGE_PREDICT);
    if (foe && (foe.charged || foe.aiProfile?.dodge)) {
      const s = this.shotReach(p, foe.x, foe.y, foe.dir, DODGE_PREDICT);
      if (s >= 0 && s < bestSteps) {
        bestSteps = s;
        escape = this.breakDir(p, foe.x, foe.y, foe.dir);
      }
    }

    return escape;
  }

  // Where a shot fired/travelling from (ox,oy) along `dir` actually detonates: the
  // first solid cell it enters (wall, pillar, death mark, or any cycle's trail —
  // exactly updateProjectiles' rule), following the torus, within `horizon` cells.
  // Returns that cell, or null if it flies clear (its blast would land too far to
  // matter). The cell ahead of the muzzle is checked first, so the firer's own
  // live head — which a real rocket slips past at launch — is never the answer.
  private detonationCell(
    ox: number,
    oy: number,
    dir: Dir,
    horizon: number,
  ): { x: number; y: number } | null {
    const dx = DELTA[dir].x;
    const dy = DELTA[dir].y;
    let cx = ox;
    let cy = oy;
    for (let i = 1; i <= horizon; i++) {
      cx = this.wrapX(cx + dx);
      cy = this.wrapY(cy + dy);
      if (this.grid[this.idx(cx, cy)] !== EMPTY) {
        // reuse the shared buffer instead of allocating a fresh {x,y} each call
        this.detCellBuf.x = cx;
        this.detCellBuf.y = cy;
        return this.detCellBuf;
      }
    }
    return null;
  }

  // Would taking a shot right now get the hunter killed? It's not enough to land
  // the hit — a rocket kills with a 5x5 blast, so we die too if that blast washes
  // back over our head. Two ways that happens:
  //   (a) OUR OWN shot detonates close enough that its blast catches us — it hits
  //       a wall just ahead, or (with `lead`, on a clear line) overflies the target
  //       and detonates on a far wall or wraps the torus back onto our own neck.
  //   (b) we'd TRADE: an armed rival already has a clear shot whose blast lands on
  //       us, so even as our rocket downs it, its rocket (loosed the same exchange)
  //       downs us. Killing someone isn't worth dying for — we hold and let the
  //       dodge reflex break us clear instead.
  // Both test the REAL detonation cell against the real 5x5 (Chebyshev within
  // BLAST_RADIUS), so "near a wall" and "on the neck" are handled, not just direct
  // line-of-body hits. nearestRival covers the duel, which is the case that matters.
  private shotWouldSelfKill(p: Player, range: number): boolean {
    const own = this.detonationCell(p.x, p.y, p.dir, PROJ_RANGE);
    if (own && this.chebyshev(p.x, p.y, own.x, own.y) <= BLAST_RADIUS) return true;

    const foe = this.nearestRival(p, range);
    if (foe && foe.charged) {
      const inc = this.detonationCell(foe.x, foe.y, foe.dir, range);
      if (inc && this.chebyshev(p.x, p.y, inc.x, inc.y) <= BLAST_RADIUS) return true;
    }
    return false;
  }

  // Survival reflex for the dodge trait (the hunter), layered on top of steering.
  // Runs every step (even while coasting), right after the heading is chosen and
  // before we shoot, so the bot reacts instantly and then resumes beelining at its
  // prey. Two reflexes, incoming fire first:
  //   1. a rocket (in flight or about to be fired) is bearing on us — break
  //      perpendicular out of its blast band.
  //   2. otherwise, don't TAILGATE: never drive into a cell hugging a living
  //      rival. The instant that rival dies it stamps a 3x3 block of solid death
  //      cells over its position, and a bot sitting one step away gets boxed in
  //      and crashes into it. We keep a one-cell cushion — still point-blank
  //      enough to gun it down (kill shots fly from a safe standoff anyway), but
  //      clear of the would-be death zone.
  // Aggression is untouched: it still takes the shot from its new heading. We
  // never reverse into our own trail and only turn where the cell is clear; if no
  // better heading exists we hold course (steering already picked the safest
  // survivable cell, and a forced turn would just crash).
  private aiAvoidDanger(p: Player): void {
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    // not mid-escape: bursting through a freshly blasted hole is a committed
    // straight line, and a sideways turn would ram the wall it just opened.
    if (!cfg.dodge || p.escapeSteps > 0) return;
    const back = opposite(p.dir);

    // 1) break out of an incoming rocket's blast band. Prefer the side with more
    // room: sidestepping into a one-deep pocket just trades the rocket for a wall
    // next step, so among the (up to two) free break directions pick the one whose
    // cell floods to the most reachable space.
    const escape = this.dodgeDir(p);
    if (escape !== null) {
      let bestDir: Dir | null = null;
      let bestRoom = -1;
      for (const d of [escape, opposite(escape)] as Dir[]) {
        if (d === back) continue;
        const ax = p.x + DELTA[d].x;
        const ay = p.y + DELTA[d].y;
        if (!this.isFree(ax, ay)) continue;
        const room = this.floodCount(ax, ay, BLAST * BLAST);
        if (room > bestRoom) {
          bestRoom = room;
          bestDir = d;
        }
      }
      if (bestDir !== null) p.dir = bestDir;
      return; // dodged, or wanted to but boxed in — either way hold the new course
    }

    // 2) keep a one-cell cushion off the nearest rival's death footprint. A rival
    // hugging us sits within Manhattan 2, so that's all we need to scan for.
    const foe = this.nearestRival(p, 2);
    if (!foe) return;
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;
    if (this.chebyshev(nx, ny, foe.x, foe.y) > 1) return; // not tailgating — fine
    // our chosen step would hug the rival; swing to a clear side that doesn't
    for (const d of [((p.dir + 1) % 4) as Dir, ((p.dir + 3) % 4) as Dir]) {
      if (d === back) continue;
      const ax = p.x + DELTA[d].x;
      const ay = p.y + DELTA[d].y;
      if (this.isFree(ax, ay) && this.chebyshev(ax, ay, foe.x, foe.y) > 1) {
        p.dir = d;
        return;
      }
    }
  }

  // Decide whether to fire this step. Rockets are a scarce, slow-charging
  // resource, so the AI spends them on purpose rather than spraying at every
  // trail it sees:
  //   1. take a clean shot at a rival in the line of fire (the kill shot),
  //   2. (hunter) blast through anything between us and the rival we're chasing,
  //   3. if boxed in with no room to run, blast through the wall ahead to escape,
  //   4. otherwise only occasionally crack a wall open to keep the arena flowing.
  // Open space a blast straight through heading `d` would reveal, capped at `cap`.
  // Walks to the first obstacle within ESC_LOOK; a rocket detonating there clears a
  // BLAST x BLAST hole, so we flood from just past it to measure the room the breach
  // actually opens. Returns space 0 when there's no wall in range (an open runway —
  // nothing to blast that way) or when the wall is thicker than one blast can clear
  // (the cell past the blast is still solid). `wallDist` is the distance to that
  // first wall (0 if none), used for the rocket-reload timing in aiEscapePlan.
  private beyondWallSpace(p: Player, d: Dir, cap: number): { space: number; wallDist: number } {
    const dx = DELTA[d].x;
    const dy = DELTA[d].y;
    let wd = 0;
    for (let i = 1; i <= ESC_LOOK; i++) {
      if (!this.isFree(p.x + dx * i, p.y + dy * i)) {
        wd = i;
        break;
      }
    }
    if (wd === 0) return { space: 0, wallDist: 0 }; // open runway — not an escape
    // the cell one blast-depth past the near wall face: free only if a single blast
    // can break through to whatever lies beyond.
    const bx = p.x + dx * (wd + BLAST_RADIUS + 1);
    const by = p.y + dy * (wd + BLAST_RADIUS + 1);
    if (!this.isFree(bx, by)) return { space: 0, wallDist: wd }; // wall too thick to clear
    return { space: this.floodCount(bx, by, cap), wallDist: wd };
  }

  // The heading whose breach opens into the most room, or null if no breakable wall
  // in reach opens into meaningfully more space than `room` (the cells we'd keep by
  // not breaching) — i.e. a real way out, not another arm of the coil. Only legal
  // turns whose first cell is free are considered, so the chosen heading never
  // drives straight into a wall.
  private escapeExitDir(p: Player, cap: number, room: number): { dir: Dir; wallDist: number } | null {
    const back = opposite(p.dir);
    let bestDir: Dir | null = null;
    let bestSpace = 0;
    let bestWall = 0;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if (d === back) continue;
      if (!this.isFree(p.x + DELTA[d].x, p.y + DELTA[d].y)) continue;
      const { space, wallDist } = this.beyondWallSpace(p, d, cap);
      if (space > bestSpace) {
        bestSpace = space;
        bestDir = d;
        bestWall = wallDist;
      }
    }
    if (bestDir === null || bestSpace < room * ESC_GAIN) return null;
    return { dir: bestDir, wallDist: bestWall };
  }

  // The turtle's "calculate a route out" override (the escapeAim trait). Runs on
  // the main thread after the greedy steering choice and before dodge/shooting, in
  // both the serial and parallel paths. While the bot still has room it does
  // nothing (the normal steering drives). The instant its reachable space drops
  // below escapeSpace it looks for the heading whose blast opens into real open
  // arena and steers at it — but only commits toward a wall it must breach when the
  // rocket will be charged by the time it arrives (travel distance at base speed vs
  // the recharge time). If the rocket won't be ready it holds the greedy survival
  // heading and circles to recharge rather than racing at a wall it can't open.
  private aiEscapePlan(p: Player): void {
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    if (!cfg.escapeAim || p.escapeSteps > 0) return;
    const cap = cfg.escapeSpace;
    // Last resort only: while the bot still has real room, the greedy survival
    // steering fills space far better than diverting to a wall — so wait until it's
    // nearly boxed (room below ESC_STEER_CRIT) before taking the wheel.
    const room = this.openSpace(p, cap);
    if (room >= ESC_STEER_CRIT) return;
    const exit = this.escapeExitDir(p, cap, room);
    if (!exit) return; // no real exit lined up yet — keep maneuvering / surviving
    if (!p.charged) {
      // speed + reload feasibility: cells to drive before a safe firing standoff,
      // at base speed (a tight pocket is no place to sprint), vs the recharge time.
      // If the rocket won't be ready in time we hold the greedy survival heading and
      // circle to recharge rather than racing at a wall we can't open.
      const cellsToFire = Math.max(0, exit.wallDist - (BLAST_RADIUS + 1));
      const timeToFire = cellsToFire * p.baseInterval; // ms
      const timeToCharge = (CHARGE_MAX - p.charge) / CHARGE_RATE; // ms
      if (timeToCharge > timeToFire) return; // won't be ready in time — stall & recharge
    }
    p.dir = exit.dir;
  }

  private aiMaybeShoot(p: Player): void {
    if (!p.charged) return;
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];

    // 0) Pacifist (the survivor): never attacks. It skips the kill shot, the
    // breach and opportunistic wall-cracking entirely, and fires only as a true
    // last resort. When every legal turn dumps it into a near-dead pocket
    // (openSpace below the threshold) it can no longer escape by steering, so it
    // blasts the wall ahead to carve an exit and commits to driving through. The
    // selfBlastSafe gate still holds: if a wall is already point-blank it can't
    // fire without catching its own blast, so it drives on and lets the steering
    // hunt for any remaining sliver rather than suicide.
    if (cfg.pacifist) {
      // Guard order is chosen for cost: selfBlastSafe + obstacleAhead are short
      // straight-line walks, while openSpace is up to three capped flood fills.
      // Run the cheap tests first so the flood only fires when a shot is actually
      // plausible; all conditions are ANDed, so the decision is unchanged.
      // A route-out bot (the turtle) has already AIMED this blast at the best
      // breach via aiEscapePlan; here we just take the shot whenever boxed, exactly
      // like the survivor. We deliberately do NOT withhold it on "the breach only
      // opens a little more room": when truly boxed, any blast that opens a hole
      // buys life, so refusing low-value breaches is how a bot gets stuck.
      if (
        cfg.escape &&
        this.selfBlastSafe(p) &&
        this.obstacleAhead(p, 6) &&
        this.openSpace(p, cfg.escapeSpace) < cfg.escapeSpace
      ) {
        this.tryShoot(p);
        p.escapeSteps = ESCAPE_STEPS;
      }
      return;
    }

    // 1) Precise kill shot — a rival sits on our firing line with nothing in
    // the way. Higher difficulties take the shot more reliably and lead targets.
    // A self-preserving dodger (the hunter) additionally HOLDS this shot whenever
    // taking it would also kill itself — the rocket's 5x5 blast washing back from a
    // point-blank target or a nearby wall, or a rival trading rockets with it the
    // same exchange (see shotWouldSelfKill). It breaks off and re-lines from safety
    // instead; other personalities still take the point-blank trade.
    const target = this.lineOfFireRival(p, cfg.aimRange, cfg.lead);
    if (target) {
      // The hunter hunts EVERYONE, fellow hunters included — its whole purpose is
      // to kill. The only shot it declines is one that would get it killed too
      // (its own blast washing back, or an armed rival trading the same exchange —
      // shotWouldSelfKill). It doesn't decline on principle; two hunters rarely
      // down each other not because they hold fire but because both are excellent
      // dodgers (aiAvoidDanger keeps stepping off each other's firing line), so a
      // clean shot is hard to land. Toughness through evasion, not pacifism.
      if (cfg.dodge && this.shotWouldSelfKill(p, cfg.aimRange)) return;
      if (Math.random() < cfg.aimTake) this.tryShoot(p);
      return;
    }

    // 2) Breach toward prey (the hunter) — the DIG, used only as a last resort.
    // We're steered at the nearest rival; if a wall or trail blocks the way, blast
    // it open and drive through. But we only dig when there is genuinely no way
    // AROUND: the breach-aware pathfinder (now penalising any run of more than
    // PF_MAX_WALL_RUN consecutive walls) routes around a thick barrier whenever a
    // finite detour exists, returning a first step into a FREE cell. So we dig only
    // when that route is itself forced into a wall (a thin enough wall to bore, or
    // a fully sealed-off prey) or no route is found at all. Heading-toward + a safe
    // standoff (selfBlastSafe) still gate it so we tunnel at the prey, not into our
    // own blast. Beyond PF_RANGE the pathfinder doesn't run, so we fall back to the
    // old behaviour (dig at whatever's ahead) — greedy chase is fine that far out.
    if (cfg.breach && this.selfBlastSafe(p)) {
      const prey = this.nearestRival(p, cfg.seekRange ?? cfg.aimRange);
      if (prey && this.headingToward(p, prey) && this.obstacleAhead(p, 8)) {
        const within = this.manhattan(p, prey) <= PF_RANGE;
        const pd = within ? this.pathToward(p, prey) : null;
        // Dig only when the cheapest route to the prey still heads straight into
        // the wall ahead (pd === our heading) or no route was found. If pd turns
        // off our heading, the pathfinder found a way AROUND — thanks to the
        // wall-run penalty that means a barrier thicker than PF_MAX_WALL_RUN with
        // any detour — so we follow that route (steering already biases to pd) and
        // hold our rocket instead of boring through. Beyond PF_RANGE pd is null and
        // we dig as before (greedy chase is fine that far out).
        const noWayAround = pd === null || pd === p.dir;
        if (noWayAround) {
          this.tryShoot(p);
          p.escapeSteps = ESCAPE_STEPS;
          return;
        }
      }
    }

    // 3) Boxing in: the reachable area is collapsing. Blast the wall ahead and
    // commit to driving straight through the gap (escapeSteps). We fire while a
    // pocket still exists rather than at the last cell, and only from a safe
    // standoff (selfBlastSafe) — the wall must be far enough ahead that the blast
    // won't catch us, and that the cell directly ahead is clear so we don't ram
    // it this step. The rocket flies ~5x faster than the cycle, so a wall a few
    // cells ahead is gone by the time we arrive.
    if (
      cfg.escape &&
      this.selfBlastSafe(p) &&
      this.obstacleAhead(p, 6) &&
      this.openSpace(p, cfg.escapeSpace) < cfg.escapeSpace
    ) {
      this.tryShoot(p);
      p.escapeSteps = ESCAPE_STEPS;
      return;
    }

    // 4) Opportunistic wall-opening — rare, so it never just spams the rocket;
    // also kept to a safe standoff so it isn't an own goal.
    if (
      Math.random() < cfg.openRate &&
      this.selfBlastSafe(p) &&
      this.obstacleAhead(p, 4)
    ) {
      this.tryShoot(p);
    }
  }

  // True when the nearest obstacle straight ahead is far enough that a rocket
  // detonating on it won't catch us in its own blast. Used to gate the bot's
  // deliberate wall-breaking shots so they don't become self-kills. (Point-blank
  // kill shots at rivals are intentionally NOT gated — a bot may trade itself.)
  //
  // The blast reaches BLAST_RADIUS cells back from the detonation cell, but we
  // also keep MOVING toward that cell after firing: the rocket only flies (and
  // detonates) after the whole cycle step resolves, so we advance one cell first
  // (we never sprint the frame we fire — see aiSprint). The obstacle must sit
  // beyond the blast radius PLUS that one-cell of motion, or the firer drives into
  // its own blast. The old BLAST_RADIUS-only standoff ignored the post-fire move
  // and let the firer slide into range — a real own-blast suicide.
  private selfBlastSafe(p: Player): boolean {
    const standoff = BLAST_RADIUS + 1;
    return this.clearAhead(p, standoff) >= standoff;
  }

  // True if driving straight ahead takes `p` closer to `t` (used so the hunter
  // only blasts a path when the obstacle is between it and its prey).
  private headingToward(p: Player, t: Player): boolean {
    const v = DELTA[p.dir];
    const dx = this.wrapDelta(t.x - p.x, this.cols);
    const dy = this.wrapDelta(t.y - p.y, this.rows);
    return v.x * Math.sign(dx) + v.y * Math.sign(dy) > 0;
  }

  // The living rival on our straight firing line within `range` (the one a rocket
  // would hit first), or null. With `lead` we also count a rival whose next step
  // crosses the line (prediction). The rocket no longer tunnels anything, so any
  // cell ahead with a trail — our own included — blocks. Returning the rival (not
  // just a bool) lets the caller inspect WHO is in the crosshairs, e.g. to observe
  // the hunter truce against a fellow dodger (see aiMaybeShoot).
  private lineOfFireRival(p: Player, range: number, lead: boolean): Player | null {
    const dx = DELTA[p.dir].x;
    const dy = DELTA[p.dir].y;

    // Large fields: O(range) walk using the head map instead of scanning every
    // cycle at each cell (the old O(range*N), brutal at range 999 x 1024 cycles).
    // headStamp/headOwner are a snapshot from rebuildSpatial; for `lead` we ask the
    // 4 neighbours of the line cell whether a head there is currently heading onto
    // it (its head dir is recorded in `dirs`), which reproduces the next-step test.
    if (this.players.length >= AI_STAGGER_MIN_CYCLES) {
      const gen = this.headGen;
      for (let i = 1; i <= range; i++) {
        const cx = this.wrapX(p.x + dx * i);
        const cy = this.wrapY(p.y + dy * i);
        const c = cy * this.cols + cx;
        if (this.headStamp[c] === gen && this.headOwner[c] !== p.id) {
          return this.players[this.headOwner[c]];
        }
        if (lead) {
          for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
            const nb = this.idx(cx - DELTA[d].x, cy - DELTA[d].y);
            if (
              this.headStamp[nb] === gen &&
              this.headOwner[nb] !== p.id &&
              this.dirs[nb] === d
            ) {
              return this.players[this.headOwner[nb]];
            }
          }
        }
        if (this.grid[c] !== EMPTY) return null; // first solid thing blocks the shot
      }
      return null;
    }

    // Small fields: exact live scan (unchanged), so their shooting is bit-identical.
    for (let i = 1; i <= range; i++) {
      const cx = this.wrapX(p.x + dx * i);
      const cy = this.wrapY(p.y + dy * i);
      for (const q of this.players) {
        if (!q.alive || q.id === p.id) continue;
        if (q.x === cx && q.y === cy) return q;
        if (
          lead &&
          this.wrapX(q.x + DELTA[q.dir].x) === cx &&
          this.wrapY(q.y + DELTA[q.dir].y) === cy
        ) {
          return q;
        }
      }
      // anything solid in the way blocks the shot — wall, pillar, death mark, or
      // any cycle's trail (the rocket detonates on the first thing it meets)
      const g = this.grid[this.idx(cx, cy)];
      if (g !== EMPTY) return null;
    }
    return null;
  }

  // Is there something the rocket can usefully detonate against within `range`
  // straight ahead? The rocket explodes on the first non-empty cell — its own
  // trail included — so any obstacle counts.
  private obstacleAhead(p: Player, range: number): boolean {
    const dx = DELTA[p.dir].x;
    const dy = DELTA[p.dir].y;
    for (let i = 1; i <= range; i++) {
      const g = this.grid[this.idx(p.x + dx * i, p.y + dy * i)];
      if (g !== EMPTY) return true; // wall, pillar, death mark, or any trail
    }
    return false;
  }

  // Largest reachable open area over the cycle's legal turns, capped at `cap`
  // (cheap early-out — we only care whether it clears the "boxed in" threshold).
  private openSpace(p: Player, cap: number): number {
    const back = opposite(p.dir);
    let best = 0;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if (d === back) continue;
      const nx = p.x + DELTA[d].x;
      const ny = p.y + DELTA[d].y;
      if (!this.isFree(nx, ny)) continue;
      best = Math.max(best, this.floodCount(nx, ny, cap));
      if (best >= cap) break;
    }
    return best;
  }

  private floodCount(sx: number, sy: number, cap: number): number {
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;
    const stamp = this.stamp;
    const gen = ++this.stampGen;
    const queue = this.floodQueue;
    const start = this.idx(sx, sy);
    queue[0] = start;
    stamp[start] = gen;
    let count = 0;
    let head = 0;
    let tail = 1;
    while (head < tail && count < cap) {
      const cur = queue[head++];
      count++;
      const x = cur % cols;
      const y = (cur - x) / cols;
      // 4-neighbour expansion. Queue cells are always in-grid, so each neighbour
      // is at most one step out of range — a single branch wraps it, replacing
      // idx()'s double modulo, and we compute the index once (was: isFree + idx).
      for (let d = 0; d < 4; d++) {
        let nx = x + DELTA[d].x;
        let ny = y + DELTA[d].y;
        if (nx < 0) nx += cols;
        else if (nx >= cols) nx -= cols;
        if (ny < 0) ny += rows;
        else if (ny >= rows) ny -= rows;
        const ni = ny * cols + nx;
        if (grid[ni] !== EMPTY) continue;
        if (stamp[ni] === gen) continue;
        stamp[ni] = gen;
        queue[tail++] = ni;
      }
    }
    return count;
  }

  // ---- camera ------------------------------------------------------------

  // The cycle a viewport's camera should currently track: the view's own pilot
  // while alive, otherwise the cycle it is spectating. Auto-picks a target the
  // first time the pilot is found dead (and re-picks if the spectated cycle has
  // since died), so a downed player always watches a live racer if one exists.
  private camTarget(v: View): Player | null {
    if (v.player.alive) return v.player;
    if (!v.spectate || !v.spectate.alive) {
      v.spectate = this.nextAlive(v.spectate, 1);
    }
    return v.spectate;
  }

  // The next living cycle after `current` (wrapping), stepping by `delta`
  // (+1 next, -1 previous). Returns the first survivor if `current` is null or
  // already dead, or null when nobody is alive.
  private nextAlive(current: Player | null, delta: number): Player | null {
    // Walk the roster directly instead of allocating a filtered alive[] each call.
    // Semantics preserved exactly: a null/dead anchor returns the first survivor in
    // roster order (old alive[0]); a live anchor returns the |delta|-th next/prev
    // live cycle, wrapping (old alive[(idx+delta)%len]). Same order because the old
    // alive[] was itself in roster order.
    const players = this.players;
    const n = players.length;
    let first: Player | null = null;
    for (let i = 0; i < n; i++) {
      if (players[i].alive) {
        first = players[i];
        break;
      }
    }
    if (first === null) return null; // nobody alive
    if (!current || !current.alive) return first; // null/dead anchor -> first survivor
    const cur = players.indexOf(current);
    const step = delta < 0 ? -1 : 1;
    let remaining = Math.abs(delta) || 1;
    let i = cur;
    for (let guard = 0; guard < n; guard++) {
      i = (i + step + n) % n;
      if (players[i].alive) {
        if (i === cur) return current; // looped back -> current is the only survivor
        if (--remaining === 0) return players[i];
      }
    }
    return current;
  }

  // Switch a downed pilot's spectate camera to the next/previous live cycle.
  // Re-locks the camera onto that cycle (cancels any free-look pan). No-op while
  // the pilot is still alive or has no viewport.
  spectateStep(pilot: Player, delta: number): void {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    v.spectate = this.nextAlive(v.spectate ?? null, delta);
    v.free = false;
  }

  // ---- spectator camera (zoom + free-look) -------------------------------
  // All of these are no-ops unless a round is in play and the targeted view's
  // own pilot is down — a live racer's camera is never zoomed or detached.

  // The split-screen view whose on-screen rect contains a canvas-space point, or
  // null. Mouse zoom/pan resolve which viewport they act on through this.
  private viewAt(sx: number, sy: number): View | null {
    for (const v of this.views) {
      if (sx >= v.rx && sx < v.rx + v.rw && sy >= v.ry && sy < v.ry + v.rh) {
        return v;
      }
    }
    return null;
  }

  // Is the pilot owning the view under this canvas point a downed spectator? Lets
  // input only capture the wheel / drag when there's actually a view to control.
  canSpectateAt(sx: number, sy: number): boolean {
    if (this.state !== "playing") return false;
    const v = this.viewAt(sx, sy);
    return !!v && !v.player.alive;
  }

  // Zoom-out floor for a view, the larger (i.e. more zoomed-in) of two limits:
  //  - reach: the whole-arena framing (torus floor) loosened by SPEC_ZOOM_OUT_X,
  //    so you can zoom out to SPEC_ZOOM_OUT_X world copies wide (the torus tiles
  //    into the rest — visibleShifts draws every entity in each visible copy);
  //  - perf: never frame more than SPEC_MAX_VISIBLE_CELLS cells, so a deep
  //    zoom-out on a giant arena can't turn the per-frame draw into a full-grid
  //    scan during the live sim (visible cells = (rw/zoom/cell)*(rh/zoom/cell)).
  // Capped at 1 so a small arena that already fits can't "zoom out" past normal.
  private minZoom(v: View): number {
    const reach = Math.max(v.rw / this.worldW, v.rh / this.worldH) / SPEC_ZOOM_OUT_X;
    const perf = Math.sqrt(
      (v.rw * v.rh) / (SPEC_MAX_VISIBLE_CELLS * this.cell * this.cell),
    );
    return Math.min(1, Math.max(reach, perf));
  }

  // Apply a zoom multiplier to a view, holding the world point under (fsx,fsy)
  // (a canvas-space pixel) fixed so zooming homes in on the cursor. While the
  // camera is still following a cycle the cam shift is harmless — updateCameras
  // re-centres next frame, so a follow-mode zoom simply scales about the target.
  private zoomView(v: View, factor: number, fsx: number, fsy: number): void {
    const z0 = v.zoom;
    const z1 = Math.max(this.minZoom(v), Math.min(SPEC_ZOOM_MAX, z0 * factor));
    if (z1 === z0) return;
    // world point currently under the focus pixel, kept put across the zoom
    const wx = v.camx + (fsx - v.rx) / z0;
    const wy = v.camy + (fsy - v.ry) / z0;
    v.camx = wx - (fsx - v.rx) / z1;
    v.camy = wy - (fsy - v.ry) / z1;
    v.zoom = z1;
  }

  // Pan a view's camera by a world-pixel delta and drop it into free-look. The
  // camera coordinate is wrapped into one world span so it never drifts off into
  // huge values across a long pan (the torus makes every position equivalent).
  private panView(v: View, dxWorld: number, dyWorld: number): void {
    v.free = true;
    v.camx = ((v.camx + dxWorld) % this.worldW + this.worldW) % this.worldW;
    v.camy = ((v.camy + dyWorld) % this.worldH + this.worldH) % this.worldH;
  }

  // Mouse-wheel zoom over a viewport. `dir` > 0 zooms in, < 0 zooms out. Returns
  // true when it acted, so the caller knows whether to swallow the page scroll.
  spectateZoomAt(sx: number, sy: number, dir: number): boolean {
    if (this.state !== "playing") return false;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return false;
    this.zoomView(v, dir > 0 ? SPEC_ZOOM_STEP : 1 / SPEC_ZOOM_STEP, sx, sy);
    return true;
  }

  // Pinch zoom (touch): scale the view under (sx,sy) by an arbitrary factor
  // about that point — the pinch midpoint stays put as the fingers spread/close.
  spectatePinchAt(sx: number, sy: number, factor: number): void {
    if (this.state !== "playing") return;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return;
    this.zoomView(v, factor, sx, sy);
  }

  // Keyboard zoom for a specific downed pilot — zooms about the view centre.
  spectateZoom(pilot: Player, dir: number): void {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    this.zoomView(
      v,
      dir > 0 ? SPEC_ZOOM_STEP : 1 / SPEC_ZOOM_STEP,
      v.rx + v.rw / 2,
      v.ry + v.rh / 2,
    );
  }

  // Mouse-drag free-look: pan the viewport under (sx,sy) by a canvas-pixel delta.
  spectatePanAt(sx: number, sy: number, dxScreen: number, dyScreen: number): void {
    if (this.state !== "playing") return;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return;
    this.panView(v, -dxScreen / v.zoom, -dyScreen / v.zoom);
  }

  // Keyboard free-look nudge for a specific downed pilot. dirX/dirY in {-1,0,1};
  // each press slides the camera a fixed fraction of the framed window.
  spectatePan(pilot: Player, dirX: number, dirY: number): void {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    this.panView(
      v,
      dirX * (v.rw / v.zoom) * SPEC_PAN_FRAC,
      dirY * (v.rh / v.zoom) * SPEC_PAN_FRAC,
    );
  }

  // Reset a downed pilot's spectate view back to the default framing: exit
  // free-look (re-lock onto the followed cycle) and restore the normal zoom. The
  // single "snap back to the action" button, useful from any zoomed/panned state.
  spectateFollow(pilot: Player): void {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    v.free = false;
    v.zoom = 1;
  }

  private updateCameras(dt: number): void {
    const lerp = Math.min(1, dt / 90);
    for (const v of this.views) {
      if (v.free) continue; // free-look: the camera stays wherever it was panned
      const t = this.camTarget(v);
      if (!t) continue; // nobody left to follow; leave the camera where it is
      const { ox, oy } = this.headOffsetVec(t);
      // the framed world window shrinks as we zoom in — centre against that, not
      // the raw viewport, so the target sits mid-screen at any zoom
      const vw = v.rw / v.zoom;
      const vh = v.rh / v.zoom;
      // centre the target; pick the wrapped copy nearest the current camera so a
      // seam crossing glides instead of whipping across the whole world
      const desiredX = this.nearestWrapPx(
        (t.x + ox + 0.5) * this.cell - vw / 2,
        v.camx,
        this.worldW,
      );
      const desiredY = this.nearestWrapPx(
        (t.y + oy + 0.5) * this.cell - vh / 2,
        v.camy,
        this.worldH,
      );
      v.camx += (desiredX - v.camx) * lerp;
      v.camy += (desiredY - v.camy) * lerp;
    }
  }

  // ---- rendering ---------------------------------------------------------

  render(): void {
    const { ctx, viewW, viewH } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, viewW, viewH);
    if (this.state === "idle" || this.views.length === 0) return;

    // at round end, pull the camera all the way out to show the whole arena
    if (this.state === "roundover") {
      this.renderOverview();
      return;
    }

    for (const v of this.views) this.renderView(v);

    // split-screen divider
    if (this.views.length > 1) {
      ctx.fillStyle = "#2a2a40";
      ctx.fillRect(this.views[0].rw, 0, this.views[1].rx - this.views[0].rw, viewH);
    }
  }

  // a single zoomed-out view of the entire world, scaled to fit the canvas
  private renderOverview(): void {
    const { ctx, viewW, viewH, worldW, worldH } = this;
    const margin = 28;
    const scale = Math.min(
      (viewW - margin * 2) / worldW,
      (viewH - margin * 2) / worldH,
    );
    const ox = (viewW - worldW * scale) / 2;
    const oy = (viewH - worldH * scale) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // background
    if (this.bgPattern) {
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(0, 0, worldW, worldH);
    } else {
      ctx.fillStyle = "#2a2a30";
      ctx.fillRect(0, 0, worldW, worldH);
    }

    // every wall and trail across the whole grid
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const gi = this.idx(x, y);
        const val = this.grid[gi];
        if (val === WALL) this.drawWall(x, y);
        else if (val === DEATH) this.drawDeath(x, y);
        else if (val >= 0) this.drawTrail(x, y, val, gi);
        else if (this.scorch[gi]) this.drawScorch(x, y);
      }
    }

    // surviving heads
    for (const p of this.players) {
      if (!p.alive) continue;
      this.drawHead(p);
    }

    ctx.restore();
  }

  private renderView(v: View): void {
    const { ctx, cell } = this;
    // world-pixel size of the framed window: the viewport rect divided out by the
    // spectator zoom (zoom 1 → exactly rw×rh, as before; zooming out grows it)
    const vw = v.rw / v.zoom;
    const vh = v.rh / v.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.rx, v.ry, v.rw, v.rh);
    ctx.clip();

    ctx.save();
    // map world pixels -> this viewport's on-screen rect, scaled by the zoom:
    //   screen = (world - cam) * zoom + r
    ctx.translate(v.rx, v.ry);
    ctx.scale(v.zoom, v.zoom);
    ctx.translate(-v.camx, -v.camy);

    // textured background
    if (this.bgPattern) {
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(v.camx, v.camy, vw, vh);
    } else {
      ctx.fillStyle = "#2a2a30";
      ctx.fillRect(v.camx, v.camy, vw, vh);
    }

    // span the full visible window (may run past the grid edges); idx() wraps
    // the lookups while the raw x/y keep the tiles continuous across the seam
    const c0 = Math.floor(v.camx / cell);
    const c1 = Math.floor((v.camx + vw) / cell);
    const r0 = Math.floor(v.camy / cell);
    const r1 = Math.floor((v.camy + vh) / cell);

    // Trails carry a per-cell gradient (drawn inline), but walls/death/scorch are a
    // few flat colours — collect those and draw them in colour-batched passes below
    // so we set fillStyle a handful of times instead of ~3x per visible cell. Cells
    // are disjoint (each is exactly one kind) so the batched order can't change the
    // image — the only difference from the old loop is far fewer canvas state changes.
    const wallXs = this.wallXs;
    const wallYs = this.wallYs;
    const deathXs = this.deathXs;
    const deathYs = this.deathYs;
    const scorchXs = this.scorchXs;
    const scorchYs = this.scorchYs;
    wallXs.length = 0;
    wallYs.length = 0;
    deathXs.length = 0;
    deathYs.length = 0;
    scorchXs.length = 0;
    scorchYs.length = 0;
    for (let y = r0; y <= r1; y++) {
      for (let x = c0; x <= c1; x++) {
        const gi = this.idx(x, y);
        const val = this.grid[gi];
        if (val === WALL) {
          wallXs.push(x);
          wallYs.push(y);
        } else if (val === DEATH) {
          deathXs.push(x);
          deathYs.push(y);
        } else if (val >= 0) {
          this.drawTrail(x, y, val, gi);
        } else if (this.scorch[gi]) {
          scorchXs.push(x);
          scorchYs.push(y);
        }
      }
    }
    this.drawSolidBatches();

    // projectiles, heads and explosions are drawn in every visible torus copy.
    // At normal framing visibleShifts yields a single copy (the nearest one);
    // only when zoomed out past one world copy does the world tile, and then each
    // entity must appear in each repeat — otherwise it would vanish from all but
    // one of the tiled arenas.
    ctx.shadowColor = "#ffcc33";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#ffe08a";
    for (const pr of this.projectiles) {
      const xs = this.visibleShifts(pr.x, v.camx, vw, this.cols, this.shiftScratchX);
      const ys = this.visibleShifts(pr.y, v.camy, vh, this.rows, this.shiftScratchY);
      for (const sx of xs) {
        for (const sy of ys) {
          const px = (pr.x + sx) * cell;
          const py = (pr.y + sy) * cell;
          ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
        }
      }
    }
    ctx.shadowBlur = 0;

    // heads (on top of trails, with glow), glided to their sub-cell position
    for (const p of this.players) {
      if (!p.alive) continue;
      const xs = this.visibleShifts(p.x, v.camx, vw, this.cols, this.shiftScratchX);
      const ys = this.visibleShifts(p.y, v.camy, vh, this.rows, this.shiftScratchY);
      for (const sx of xs) {
        for (const sy of ys) {
          // nearest copy needs no shift — skip the save/translate/restore in the
          // common (non-tiled) case; drawCycle uses absolute coords + its own state
          if (sx === 0 && sy === 0) {
            this.drawCycle(p);
          } else {
            ctx.save();
            ctx.translate(sx * cell, sy * cell);
            this.drawCycle(p);
            ctx.restore();
          }
        }
      }
    }

    // explosions (topmost)
    for (const e of this.explosions) {
      const xs = this.visibleShifts(e.x, v.camx, vw, this.cols, this.shiftScratchX);
      const ys = this.visibleShifts(e.y, v.camy, vh, this.rows, this.shiftScratchY);
      for (const sx of xs) {
        for (const sy of ys) {
          if (sx === 0 && sy === 0) {
            this.drawExplosion(e);
          } else {
            ctx.save();
            ctx.translate(sx * cell, sy * cell);
            this.drawExplosion(e);
            ctx.restore();
          }
        }
      }
    }

    ctx.restore(); // drop world transform, keep clip

    this.drawOffscreenIndicators(v);
    this.drawViewHud(v);
    ctx.restore();
  }

  // Edge-of-screen markers pointing toward the nearest off-screen rivals, so you
  // can tell where threats are when the camera only frames a sliver of a big
  // arena. Drawn in canvas coords with the viewport clip still active. Capped at
  // the closest cycles so a 500-strong field can't ring the screen, and each
  // arrow's size + opacity scales with proximity so nearer threats read louder.
  private drawOffscreenIndicators(v: View): void {
    const { ctx, cell } = this;
    const subject = v.player.alive ? v.player : this.camTarget(v);
    if (!subject) return;

    const cx = v.rx + v.rw / 2;
    const cy = v.ry + v.rh / 2;
    const margin = 22;
    const left = v.rx + margin;
    const right = v.rx + v.rw - margin;
    const top = v.ry + margin;
    const bottom = v.ry + v.rh - margin;

    // off-screen rivals with their on-canvas position (nearest wrapped copy).
    // the framed window and the world->screen projection both fold in the zoom.
    const vw = v.rw / v.zoom;
    const vh = v.rh / v.zoom;
    // Keep only the 10 nearest off-screen rivals via bounded insertion into reusable
    // parallel arrays (sorted ascending by dist) — no per-rival object and no full
    // sort. Result is identical to the old marks.sort().slice(0, 10).
    const MAX = 10;
    const sxs = this.markSx;
    const sys = this.markSy;
    const dists = this.markDist;
    const colors = this.markColor;
    let count = 0;
    for (const p of this.players) {
      if (!p.alive || p === subject) continue;
      const wx = this.wrapNearCell(p.x, v.camx, vw, this.cols);
      const wy = this.wrapNearCell(p.y, v.camy, vh, this.rows);
      const sx = ((wx + 0.5) * cell - v.camx) * v.zoom + v.rx;
      const sy = ((wy + 0.5) * cell - v.camy) * v.zoom + v.ry;
      // visible inside the viewport? then it speaks for itself — no marker
      if (sx >= v.rx && sx <= v.rx + v.rw && sy >= v.ry && sy <= v.ry + v.rh) {
        continue;
      }
      const dx = sx - cx;
      const dy = sy - cy;
      const dist = dx * dx + dy * dy;
      // skip if the buffer is full and this rival isn't closer than the current worst
      if (count === MAX && dist >= dists[MAX - 1]) continue;
      let pos = count < MAX ? count++ : MAX - 1;
      while (pos > 0 && dists[pos - 1] > dist) {
        dists[pos] = dists[pos - 1];
        sxs[pos] = sxs[pos - 1];
        sys[pos] = sys[pos - 1];
        colors[pos] = colors[pos - 1];
        pos--;
      }
      dists[pos] = dist;
      sxs[pos] = sx;
      sys[pos] = sy;
      colors[pos] = p.color;
    }
    if (count === 0) return;

    // the nearest is the biggest and they shrink down the list, so the ordering
    // itself reads as proximity.
    for (let i = 0; i < count; i++) {
      const dx = sxs[i] - cx;
      const dy = sys[i] - cy;
      // first edge of the inset viewport rect the centre->rival ray crosses
      const tx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity;
      const ty =
        dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      const ex = Math.max(left, Math.min(right, cx + dx * t));
      const ey = Math.max(top, Math.min(bottom, cy + dy * t));

      // rank in [0,1]: 1 for the closest, 0 for the 10th — drives size + opacity
      const rank = count > 1 ? 1 - i / (count - 1) : 1;
      const s = (9 + 16 * rank) * 0.7; // arrowhead half-length, ~18px nearest .. ~6px
      const alpha = 0.55 + 0.45 * rank;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ex, ey);
      ctx.rotate(Math.atan2(dy, dx));

      // bold arrowhead with a brightened core and dark outline for contrast
      ctx.beginPath();
      ctx.moveTo(s, 0); // tip points outward toward the rival
      ctx.lineTo(-s * 0.75, s * 0.8);
      ctx.lineTo(-s * 0.75, -s * 0.8);
      ctx.closePath();
      ctx.fillStyle = brighten(colors[i], 0.35);
      ctx.shadowColor = colors[i];
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0a0a10";
      ctx.stroke();
      ctx.restore();
    }
  }

  // Draw one trail cell as a slice of a glossy round tube. The cell fills
  // edge-to-edge with a smooth gradient, so a straight run is one continuous
  // shaded bar (no visible grid). The orientation comes from the *driven path*
  // (the cell's entry direction and its successor), not mere adjacency, so two
  // parallel lines stay separate and a turn renders as a proper elbow block.
  // `base` is the cell's already-wrapped grid index (computed by the render
  // loop), so we don't re-run idx() for this cell. The trail gradients are
  // anchored in cell-local space, so we still translate to (px,py) to fill —
  // but undo it with a counter-translate instead of a save/restore stack push.
  private drawTrail(x: number, y: number, id: number, base: number): void {
    const { ctx, cell } = this;
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;
    const dirs = this.dirs;
    const grads = this.trailGrads[id];
    const px = x * cell;
    const py = y * cell;
    const dir = dirs[base] as Dir;

    // is there a successor cell — a same-player neighbour that was entered by
    // moving in that exact direction (i.e. driven from here)? Wrap each
    // neighbour with a single branch from this cell's in-grid coords.
    const gx = base % cols;
    const gy = (base - gx) / cols;
    let fwd = -1;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      let nx = gx + DELTA[d].x;
      let ny = gy + DELTA[d].y;
      if (nx < 0) nx += cols;
      else if (nx >= cols) nx -= cols;
      if (ny < 0) ny += rows;
      else if (ny >= rows) ny -= rows;
      const ni = ny * cols + nx;
      if (grid[ni] === id && dirs[ni] === d) {
        fwd = d;
        break;
      }
    }

    // bend if the line leaves in a different direction than it came in;
    // otherwise it's a straight segment (or an end cap) along its own axis
    let g: CanvasGradient;
    if (fwd !== -1 && fwd !== dir) {
      g = grads.d;
    } else {
      const axis = fwd !== -1 ? fwd : dir;
      g = axis === 0 || axis === 2 ? grads.v : grads.h;
    }

    ctx.translate(px, py);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cell, cell);
    ctx.translate(-px, -py);
  }

  private drawWall(x: number, y: number): void {
    const { ctx, cell } = this;
    const px = x * cell;
    const py = y * cell;
    ctx.fillStyle = "#23233a";
    ctx.fillRect(px, py, cell, cell);
    ctx.fillStyle = "#3a3a5e";
    ctx.fillRect(px, py, cell, 2);
    ctx.fillStyle = "#14142440";
    ctx.fillRect(px, py + cell - 2, cell, 2);
  }

  // a persistent gray scorch left on an empty cell where an explosion happened
  private drawScorch(x: number, y: number): void {
    const { ctx, cell } = this;
    ctx.fillStyle = "rgba(60, 60, 66, 0.7)";
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }

  private drawDeath(x: number, y: number): void {
    const { ctx, cell } = this;
    const px = x * cell;
    const py = y * cell;
    ctx.fillStyle = "#000000";
    ctx.fillRect(px, py, cell, cell);
    // faint edge so the black block reads against the dark background
    ctx.fillStyle = "#1c1c24";
    ctx.fillRect(px, py, cell, 1);
    ctx.fillRect(px, py, 1, cell);
  }

  // Draw the walls/death/scorch cells collected by renderView in colour-batched
  // passes: fillStyle is set once per colour for the whole frame instead of per
  // cell. Pixel-identical to the per-cell drawWall/drawDeath/drawScorch (the cells
  // are disjoint, so paint order between them is irrelevant).
  private drawSolidBatches(): void {
    const { ctx, cell } = this;
    const wx = this.wallXs;
    const wy = this.wallYs;
    const dx = this.deathXs;
    const dy = this.deathYs;
    const sx = this.scorchXs;
    const sy = this.scorchYs;

    if (sx.length) {
      ctx.fillStyle = "rgba(60, 60, 66, 0.7)";
      for (let i = 0; i < sx.length; i++) ctx.fillRect(sx[i] * cell, sy[i] * cell, cell, cell);
    }
    if (wx.length) {
      ctx.fillStyle = "#23233a";
      for (let i = 0; i < wx.length; i++) ctx.fillRect(wx[i] * cell, wy[i] * cell, cell, cell);
      ctx.fillStyle = "#3a3a5e";
      for (let i = 0; i < wx.length; i++) ctx.fillRect(wx[i] * cell, wy[i] * cell, cell, 2);
      ctx.fillStyle = "#14142440";
      for (let i = 0; i < wx.length; i++)
        ctx.fillRect(wx[i] * cell, wy[i] * cell + cell - 2, cell, 2);
    }
    if (dx.length) {
      ctx.fillStyle = "#000000";
      for (let i = 0; i < dx.length; i++) ctx.fillRect(dx[i] * cell, dy[i] * cell, cell, cell);
      ctx.fillStyle = "#1c1c24";
      for (let i = 0; i < dx.length; i++) {
        ctx.fillRect(dx[i] * cell, dy[i] * cell, cell, 1);
        ctx.fillRect(dx[i] * cell, dy[i] * cell, 1, cell);
      }
    }
  }

  private drawExplosion(e: Explosion): void {
    const { ctx, cell } = this;
    const t = Math.max(0, 1 - e.age / e.life);
    const px = e.x * cell;
    const py = e.y * cell;
    const size = e.size * cell;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.shadowColor = "#ffaa33";
    ctx.shadowBlur = 24;
    // outer fireball shrinks slightly as it fades
    const inset = (1 - t) * cell;
    ctx.fillStyle = "#ff7a1a";
    ctx.fillRect(px + inset, py + inset, size - 2 * inset, size - 2 * inset);
    // hot core
    ctx.fillStyle = "#ffe7a0";
    ctx.fillRect(px + cell, py + cell, size - 2 * cell, size - 2 * cell);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Draw the cycle's head as the "car": a glowing black tile marked with a
  // bright hazard X in the player's colour, as in the reference.
  // How far (0..1) the cycle has travelled toward its next cell since the last
  // grid step — drives smooth sub-cell motion while the simulation stays grid-based.
  private headFrac(p: Player): number {
    return p.interval > 0 ? Math.max(0, Math.min(1, p.acc / p.interval)) : 0;
  }

  // The direction the cycle will move next: a human's next queued turn if any,
  // otherwise its current heading. (AI picks its turn at step time, so we can
  // only lead with the current heading there.)
  private nextDir(p: Player): Dir {
    if (p.type === "human" && p.inputQueue.length > 0) return p.inputQueue[0];
    return p.dir;
  }

  // Sub-cell offset of the rendered head, in cell units, toward the next cell.
  private headOffsetVec(p: Player): { ox: number; oy: number } {
    if (!p.alive) return { ox: 0, oy: 0 };
    const d = this.nextDir(p);
    const nx = p.x + DELTA[d].x;
    const ny = p.y + DELTA[d].y;
    if (!this.isFree(nx, ny)) return { ox: 0, oy: 0 }; // about to stop/crash
    const f = this.headFrac(p);
    return { ox: DELTA[d].x * f, oy: DELTA[d].y * f };
  }

  // Draw a moving cycle: first grow the leading bit of trail into the next cell
  // so the line keeps up with the gliding car (no whole-block pop-in), then the
  // car itself at its interpolated position.
  private drawCycle(p: Player): void {
    const { ctx, cell } = this;
    const d = this.nextDir(p);
    const nx = p.x + DELTA[d].x;
    const ny = p.y + DELTA[d].y;
    const lead = this.isFree(nx, ny);
    const f = lead ? this.headFrac(p) : 0;

    if (f > 0) {
      const vertical = d === 0 || d === 2;
      const g = vertical ? this.trailGrads[p.id].v : this.trailGrads[p.id].h;
      const ext = cell * f;
      ctx.save();
      ctx.fillStyle = g;
      if (d === 1) {
        // right: grow rightward from the head cell into the next cell
        ctx.translate(p.x * cell, p.y * cell);
        ctx.fillRect(cell, 0, ext, cell);
      } else if (d === 3) {
        // left
        ctx.translate(nx * cell, p.y * cell);
        ctx.fillRect(cell - ext, 0, ext, cell);
      } else if (d === 2) {
        // down
        ctx.translate(p.x * cell, p.y * cell);
        ctx.fillRect(0, cell, cell, ext);
      } else {
        // up
        ctx.translate(p.x * cell, ny * cell);
        ctx.fillRect(0, cell - ext, cell, ext);
      }
      ctx.restore();
    }

    const { ox, oy } = lead
      ? { ox: DELTA[d].x * f, oy: DELTA[d].y * f }
      : { ox: 0, oy: 0 };
    this.drawHead(p, ox, oy);
  }

  private drawHead(p: Player, ox = 0, oy = 0): void {
    const { ctx, cell } = this;
    const px = (p.x + ox) * cell;
    const py = (p.y + oy) * cell;
    const m = Math.max(1, Math.round(cell * 0.08));

    // glowing black body
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#0a0a10";
    ctx.fillRect(px + m, py + m, cell - 2 * m, cell - 2 * m);
    ctx.shadowBlur = 0;

    // hazard X
    ctx.strokeStyle = p.headColor;
    ctx.lineWidth = Math.max(2, Math.round(cell * 0.18));
    ctx.lineCap = "round";
    const a = px + cell * 0.26;
    const b = px + cell * 0.74;
    const c = py + cell * 0.26;
    const d = py + cell * 0.74;
    ctx.beginPath();
    ctx.moveTo(a, c);
    ctx.lineTo(b, d);
    ctx.moveTo(b, c);
    ctx.lineTo(a, d);
    ctx.stroke();
  }

  private drawViewHud(v: View): void {
    const { ctx } = this;
    const own = v.player;
    // while the pilot is down the camera follows another cycle; the meter and
    // sprint readout should describe whoever we're actually watching
    const subject = own.alive ? own : this.camTarget(v);

    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.textBaseline = "top";
    if (own.alive) {
      ctx.fillStyle = own.color;
      ctx.fillText(own.name, v.rx + 10, v.ry + 8);
    } else {
      ctx.fillStyle = "#777788";
      ctx.fillText(`${own.name} — DOWN`, v.rx + 10, v.ry + 8);
      // once every human is down the round can be called from here, so prompt
      // for it; otherwise a teammate is still racing and bailing isn't offered
      const canEnd = !this.humansAlive();
      // a zoom readout, shown only when it's been changed from the default
      const zoomTag = v.zoom !== 1 ? `  ·  ${v.zoom.toFixed(1)}×` : "";
      if (subject) {
        // free-look detaches the camera — ring the viewport in amber so the
        // "you're no longer locked on a cycle" state reads at a glance
        if (v.free) {
          ctx.save();
          ctx.strokeStyle = "rgba(255, 207, 106, 0.5)";
          ctx.lineWidth = 2;
          ctx.strokeRect(v.rx + 1.5, v.ry + 1.5, v.rw - 3, v.rh - 3);
          ctx.restore();
        }
        ctx.font = "bold 12px 'Courier New', monospace";
        if (v.free) {
          // camera detached, so name the mode rather than a followed target
          ctx.fillStyle = "#ffcf6a";
          ctx.fillText(`FREE LOOK${zoomTag}`, v.rx + 10, v.ry + 27);
        } else {
          // place the name + zoom tag by measured text width (no magic offsets,
          // so any font/name change stays correctly spaced)
          const label = "SPECTATING ";
          ctx.fillStyle = "#aaaabb";
          ctx.fillText(label, v.rx + 10, v.ry + 27);
          const nameX = v.rx + 10 + ctx.measureText(label).width;
          ctx.fillStyle = subject.color;
          ctx.fillText(subject.name, nameX, v.ry + 27);
          if (zoomTag) {
            ctx.fillStyle = "#aaaabb";
            ctx.fillText(zoomTag, nameX + ctx.measureText(subject.name).width, v.ry + 27);
          }
        }
        ctx.fillStyle = "#9a9aa8";
        ctx.font = "10px 'Courier New', monospace";
        // controls hint, grouped by input so the scheme reads as discoverable
        ctx.fillText("keys:  ◄► cycle   ▲▼ zoom   sprint+arrows pan", v.rx + 10, v.ry + 44);
        ctx.fillText("mouse: wheel zoom   drag to pan", v.rx + 10, v.ry + 57);
        ctx.fillText("fire: reset view", v.rx + 10, v.ry + 70);
        if (canEnd) ctx.fillText("↵ end round", v.rx + 10, v.ry + 83);
      } else {
        ctx.fillStyle = "#9a9aa8";
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillText("no cycles left to follow", v.rx + 10, v.ry + 27);
        if (canEnd) ctx.fillText("↵ end round", v.rx + 10, v.ry + 41);
      }
    }

    if (!subject) return;
    const p = subject;

    // charge meter
    const bw = 130;
    const bh = 9;
    const bx = v.rx + 10;
    const by = v.ry + v.rh - 22;
    ctx.fillStyle = "#000000aa";
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.strokeStyle = "#44445e";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 2, by - 2, bw + 4, bh + 4);
    const frac = Math.max(0, Math.min(1, p.charge / CHARGE_MAX));
    ctx.fillStyle = p.charged ? "#ffcc33" : "#7a5a1e";
    ctx.fillRect(bx, by, bw * frac, bh);
    ctx.fillStyle = p.charged ? "#1a1400" : "#9a9aa8";
    ctx.font = "10px 'Courier New', monospace";
    ctx.fillText(p.charged ? "ROCKET READY" : "CHARGING", bx + 6, by - 1);

    if (p.sprint && p.alive) {
      ctx.fillStyle = "#55ffff";
      ctx.font = "bold 11px 'Courier New', monospace";
      ctx.fillText("SPRINT", bx + bw + 14, by - 1);
    }
  }

  // build the background pattern once: a block of gray metallic floor tiles
  // (thin grout grid + bevel) wrapped by a thick dark seam, so the seams repeat
  // every PANEL cells to form the larger panel grid seen in the reference.
  private makeBgPattern(): CanvasPattern | null {
    const cell = this.cell;
    const PANEL = 4; // tiles per panel
    const size = cell * PANEL;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const c = off.getContext("2d");
    if (!c) return null;

    // fine tiles across the panel
    for (let ty = 0; ty < PANEL; ty++) {
      for (let tx = 0; tx < PANEL; tx++) {
        const ox = tx * cell;
        const oy = ty * cell;
        // grout between tiles
        c.fillStyle = "#5a5a61";
        c.fillRect(ox, oy, cell, cell);
        // tile face
        c.fillStyle = "#8c8c93";
        c.fillRect(ox + 1, oy + 1, cell - 2, cell - 2);
        // bevel: lighter top-left
        c.fillStyle = "#9a9aa1";
        c.fillRect(ox + 1, oy + 1, cell - 2, 1);
        c.fillRect(ox + 1, oy + 1, 1, cell - 2);
        // bevel: darker bottom-right
        c.fillStyle = "#76767c";
        c.fillRect(ox + 1, oy + cell - 2, cell - 2, 1);
        c.fillRect(ox + cell - 2, oy + 1, 1, cell - 2);
        // faint centre stud for a bit of texture
        c.fillStyle = "#96969d";
        c.fillRect(ox + cell / 2 - 1, oy + cell / 2 - 1, 2, 2);
      }
    }

    // thick panel seam along the top and left edges of the block (repeats into
    // the neighbours' bottom/right, so seams sit on every PANEL boundary)
    const t = 3;
    c.fillStyle = "#1b1b1f";
    c.fillRect(0, 0, size, t);
    c.fillRect(0, 0, t, size);
    // a soft highlight just inside the seam
    c.fillStyle = "#6f6f76";
    c.fillRect(t, t, size - t, 1);
    c.fillRect(t, t, 1, size - t);

    return this.ctx.createPattern(off, "repeat");
  }
}
