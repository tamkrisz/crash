export type Dir = 0 | 1 | 2 | 3; // 0 up, 1 right, 2 down, 3 left

export interface Vec {
  x: number;
  y: number;
}

// indexed by Dir
export const DELTA: Vec[] = [
  { x: 0, y: -1 }, // up
  { x: 1, y: 0 }, // right
  { x: 0, y: 1 }, // down
  { x: -1, y: 0 }, // left
];

export const opposite = (d: Dir): Dir => (((d + 2) % 4) as Dir);

export type PlayerType = "human" | "ai";

export interface KeyMap {
  up: string;
  down: string;
  left: string;
  right: string;
  sprint: string; // event.code
  shoot: string; // event.code
}

export interface PlayerConfig {
  name: string;
  color: string;
  type: PlayerType;
  keys?: KeyMap;
  personality?: Personality; // AI only — the driving character
}

export type Speed = "slow" | "normal" | "fast";

// Arena size. "small" is the original 160x110 grid; the larger sizes keep a
// similar aspect ratio so the camera framing stays consistent.
export type MapSize = "small" | "medium" | "large";

export const MAP_DIMENSIONS: Record<MapSize, { cols: number; rows: number }> = {
  small: { cols: 160, rows: 110 },
  medium: { cols: 220, rows: 150 },
  large: { cols: 300, rows: 200 },
};

// Game modes.
//   classic — one arena, every cycle on a single spawn ring (the original).
//   mega    — an 8x-area battleground carved into four quadrant arenas joined by
//             narrow tunnels, with 16 cycles spawned in each (64 total).
//   giga    — same four-chamber layout, 4x the mega area (32x the base arena),
//             with 32 cycles in each quadrant (128 total) and a thicker frame.
//   tera    — same four-chamber layout, 4x the giga area (128x the base arena),
//             with 128 cycles in each quadrant (512 total) and a massive frame.
//   Last cycle running wins in every mode.
export type GameMode = "classic" | "mega" | "giga" | "tera";

// A "quad" mode is a fixed-size battleground split into four quadrant arenas
// joined by tunnels, with `perQuadrant` cycles spawned in each (4 * perQuadrant
// total). `border` is the outer frame thickness; the inner divider walls keep
// the base width regardless.
export interface QuadSpec {
  cols: number;
  rows: number;
  perQuadrant: number;
  border: number;
}

export const QUAD_SPECS: Partial<Record<GameMode, QuadSpec>> = {
  // 440x320 = 140800 cells, exactly 8x the 160x110 base arena; 64 cycles.
  mega: { cols: 440, rows: 320, perQuadrant: 16, border: 10 },
  // 880x640 = 563200 cells, exactly 4x the mega arena (32x base); 128 cycles,
  // with a chunky outer frame befitting the sprawl.
  giga: { cols: 880, rows: 640, perQuadrant: 32, border: 28 },
  // 1760x1280 = 2252800 cells, exactly 4x the giga arena (128x base); 512
  // cycles, 128 per chamber, with a massive outer frame for the colossal sprawl.
  tera: { cols: 1760, rows: 1280, perQuadrant: 128, border: 56 },
};

// AI skill. "easy" aims poorly and sees only nearby rivals. "hard" is precise at
// medium range, leads moving targets, and steers cleanly. "cheating" is unfair on
// purpose — arena-wide aim, never misses, blasts out of any pocket, looks ahead
// extremely far, and sprints constantly, making it close to impossible to kill.
// "evolved" is not hand-tuned: it's a profile bred by a genetic algorithm over
// thousands of simulated matches (see train/) to survive a field of cheating
// hunters — a fast, evasive duelist that hoards space, dodges fire, and outlasts
// everyone.
export type Difficulty =
  | "easy"
  | "hard"
  | "cheating"
  | "evolved";

// Per-bot AI behaviour. The difficulty (above) picks a base profile; a
// personality (below) then transforms it into the bot's actual driving style.
// Shooting and steering both read these knobs — see AI_DIFFICULTY in game.ts for
// the tuned per-difficulty values and PERSONALITY_STYLE for the style transforms.
//   aimRange    cells of clear line-of-sight scanned for a rival to snipe
//   seekRange   how far the bot searches for a rival to *pursue* while steering
//               (defaults to aimRange). The hunter sets this arena-wide so it
//               always has a target to chase, even when it can't yet shoot that far.
//   aimTake     probability of actually taking a clean shot (1 = never misses the chance)
//   lead        also fire when the target's *next* cell crosses the line (predict movement)
//   escape      when boxed in, blast through a wall ahead to open an exit
//   escapeSpace reachable-area threshold below which the cycle counts as "boxed in"
//   openRate    per-step chance to opportunistically crack open a wall
//   flood       flood-fill depth used when picking a turn (deeper = sees dead ends sooner)
//   open        weight on the "openness" term (free cells around a candidate move).
//               Positive pulls toward open arena (anti-spiral); NEGATIVE makes the
//               bot hug walls and pack tight (see the "packer" personality).
//   hunt        weight on the "hunting" term: steer to line up a shot on a rival
//   straight    bonus for keeping a straight line
//   jitter      random noise added to steering scores (more = sloppier driving)
//   alwaysSprint run at sprint speed every step instead of only down clear runs
//   stalk       shadow the nearest rival even with an empty rocket (the ambusher
//               trait): close the gap and cut across its path to force a crash
//   breach      blast rockets through any wall/trail sitting between the bot and
//               the rival it's chasing, then drive through the gap — the hunter
//               trait, so nothing stops it reaching its prey
//   pathfind    steer along a computed breach-aware shortest path to the nearest
//               rival (route around obstacles, or straight through a wall when
//               that's the easiest way) instead of greedily — the hunter trait,
//               so it never gets stuck circling a wall it can't navigate
//   dodge       a survival reflex: spot an enemy rocket bearing down on us and
//               break perpendicular, out of its blast band, then resume the
//               chase. The hunter trait — it stays relentlessly on the attack
//               but no longer drives blindly into incoming fire (aiAvoidDanger).
export interface AiProfile {
  aimRange: number;
  seekRange?: number;
  aimTake: number;
  lead: boolean;
  escape: boolean;
  escapeSpace: number;
  openRate: number;
  flood: number;
  open: number;
  hunt: number;
  straight: number;
  jitter: number;
  alwaysSprint?: boolean;
  stalk?: boolean;
  breach?: boolean;
  pathfind?: boolean;
  dodge?: boolean;
  // Never attacks. Skips every offensive shot (kill shot, breach, opportunistic
  // wall-crack); the only rocket it ever fires is the last-ditch escape blast,
  // and only once steering can no longer find a way out. The survivor's trait.
  pacifist?: boolean;
  // Active rival-avoidance — the turtle's signature trait. A steering term that
  // pulls the bot to MAXIMISE distance from the nearest rival (and stay off its
  // row/column, where a shot could land): the exact inverse of the hunt/aim term,
  // so a positive weight rewards fleeing and penalises closing or lining up. It's
  // a secondary nudge — flood and openness still dominate the score, so the bot
  // peels away from rivals without ever fleeing into a trap. 0/undefined = off
  // (the survivor merely IGNORES rivals; only the turtle actively flees them).
  avoid?: number;
  // How far (toroidal Manhattan) to look for the rival to flee from. Defaults to
  // seekRange ?? aimRange; the turtle sets it wide so it drifts clear of an
  // approaching rival long before that rival is ever a threat ("sees far ahead").
  avoidRange?: number;
  // Route-out planning when boxed in (the turtle's trait). Once nearly boxed, steer
  // the escape at the heading whose breach opens into the most room (not just
  // whatever's straight ahead), and only commit toward a wall it must breach once
  // the rocket will be charged by the time it arrives — travel distance vs reload
  // time; otherwise circle to recharge (see aiEscapePlan). A genuine last resort
  // (ESC_STEER_CRIT) so it never disrupts the space-filling that keeps the bot
  // alive — and it never WITHHOLDS the escape shot (when truly boxed, any blast
  // that opens a hole extends life, so refusing "low-value" breaches just gets the
  // bot stuck). Main-thread only; the worker steering path is untouched.
  escapeAim?: boolean;
  // Never coast: re-run the FULL steering scan every single step instead of
  // reusing the last heading down clear straights (see Game.aiThink / planOne).
  // The turtle trades CPU for vigilance — it always replans, so it spots a
  // collapsing pocket or an approaching rival the instant either appears. The
  // staggered-coast optimisation only engages at AI_STAGGER_MIN_CYCLES+ cycles,
  // so this only changes behaviour in big fields — exactly where it matters.
  noCoast?: boolean;
}

// AI "characters" — a driving STYLE layered on top of the skill profile, so a
// HUNTER on EASY aims poorly but still hunts, while on HARD it's lethal. The
// transforms live in PERSONALITY_STYLE (game.ts). "balanced" is the neutral
// all-rounder used before characters existed, so a default match is unchanged.
export type Personality =
  | "balanced"
  | "hunter"
  | "hunterplus"
  | "packer"
  | "runner"
  | "survivor"
  | "turtle"
  | "demolisher"
  | "roamer"
  | "ambusher";

export interface PersonalityMeta {
  id: Personality;
  label: string; // menu button text
  code: string; // short tag used to name bots of this character (e.g. "HUN")
  blurb: string; // one-line description (tooltip / roster row hint)
}

// Order here is the order shown in the menu and roster picker.
export const PERSONALITIES: PersonalityMeta[] = [
  {
    id: "balanced",
    label: "BALANCED",
    code: "BAL",
    blurb: "All-rounder — the standard skill profile, no special leanings.",
  },
  {
    id: "hunter",
    label: "HUNTER",
    code: "HUN",
    blurb: "Killer — lives only to track down rivals across the arena and gun them down.",
  },
  {
    id: "hunterplus",
    label: "HUNTER+",
    code: "HU+",
    blurb: "Trained killer — a GA-evolved hunter tuned purely to rack up the most kills in giant 128-cycle matches.",
  },
  {
    id: "packer",
    label: "PACKER",
    code: "PAK",
    blurb: "Tightest fit — hugs walls and its own trail to pack the most compact coil.",
  },
  {
    id: "runner",
    label: "RUNNER",
    code: "RUN",
    blurb: "Speed-demon — laser-straight long runs at full sprint, turns only when forced.",
  },
  {
    id: "survivor",
    label: "SURVIVOR",
    code: "SUR",
    blurb: "Pacifist — never attacks, hoards open space, only blasts an exit when truly cornered.",
  },
  {
    id: "turtle",
    label: "TURTLE",
    code: "TUR",
    blurb: "Ultimate survivalist — never fights, actively flees every rival, looks far ahead and re-plans every step to outlast the whole field.",
  },
  {
    id: "demolisher",
    label: "DEMOLISH",
    code: "DEM",
    blurb: "Wall-breaker — blasts walls open constantly, sprints, and fights with abandon.",
  },
  {
    id: "roamer",
    label: "ROAMER",
    code: "ROM",
    blurb: "Explorer — ranges wide across open arena claiming fresh territory.",
  },
  {
    id: "ambusher",
    label: "AMBUSH",
    code: "AMB",
    blurb: "Stalker — shadows the nearest rival then cuts across its path to force a crash.",
  },
];

// How the rival field is composed from characters.
//   uniform — every bot is the single chosen personality (the default)
//   counts  — explicit count per personality (sum sets the rival total)
//   random  — each bot gets a random personality drawn from `pool`
export type RosterMode = "uniform" | "counts" | "random";

export interface AiRoster {
  mode: RosterMode;
  personality: Personality; // used by "uniform"
  counts: Partial<Record<Personality, number>>; // used by "counts"
  pool: Personality[]; // used by "random" (empty = all characters)
}

export interface MatchConfig {
  humans: number;
  ai: number;
  speed: Speed;
  difficulty: Difficulty;
  map: string; // ArenaMap id, see maps.ts (in quad modes, stamped per quadrant)
  size: MapSize; // arena dimensions, see MAP_DIMENSIONS (ignored in quad modes)
  mode?: GameMode; // defaults to "classic"
  roster?: AiRoster; // how to assign characters to bots (defaults to balanced)
}

// Faithful-ish VGA 16-colour flavoured palette. Order = pick order.
export const PALETTE: { name: string; color: string }[] = [
  { name: "CYAN", color: "#55ffff" },
  { name: "YELLOW", color: "#ffff55" },
  { name: "RED", color: "#ff5555" },
  { name: "GREEN", color: "#55ff55" },
  { name: "MAGENTA", color: "#ff55ff" },
  { name: "WHITE", color: "#ffffff" },
  { name: "AZURE", color: "#5577ff" },
  { name: "ORANGE", color: "#ffaa00" },
  { name: "LIME", color: "#aaff00" },
  { name: "ROSE", color: "#ff77aa" },
];

export const HUMAN_KEYS: KeyMap[] = [
  {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    sprint: "ShiftRight",
    shoot: "Slash",
  },
  {
    up: "KeyW",
    down: "KeyS",
    left: "KeyA",
    right: "KeyD",
    sprint: "ShiftLeft",
    shoot: "Space",
  },
];
