// src/colors.ts
function parse(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function to2(c) {
  return Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0");
}
function mix(hex, target, amt) {
  const [r, g2, b] = parse(hex);
  const [tr, tg, tb] = parse(target);
  return `#${to2(r + (tr - r) * amt)}${to2(g2 + (tg - g2) * amt)}${to2(
    b + (tb - b) * amt
  )}`;
}
var brighten = (hex, amt) => mix(hex, "#ffffff", amt);
var darken = (hex, amt) => mix(hex, "#000000", amt);
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = l - c / 2;
  let r = 0;
  let g2 = 0;
  let b = 0;
  if (h < 60) [r, g2, b] = [c, x, 0];
  else if (h < 120) [r, g2, b] = [x, c, 0];
  else if (h < 180) [r, g2, b] = [0, c, x];
  else if (h < 240) [r, g2, b] = [0, x, c];
  else if (h < 300) [r, g2, b] = [x, 0, c];
  else [r, g2, b] = [c, 0, x];
  return `#${to2((r + m) * 255)}${to2((g2 + m) * 255)}${to2((b + m) * 255)}`;
}

// src/types.ts
var DELTA = [
  { x: 0, y: -1 },
  // up
  { x: 1, y: 0 },
  // right
  { x: 0, y: 1 },
  // down
  { x: -1, y: 0 }
  // left
];
var opposite = (d) => (d + 2) % 4;
var MAP_DIMENSIONS = {
  small: { cols: 160, rows: 110 },
  medium: { cols: 220, rows: 150 },
  large: { cols: 300, rows: 200 }
};
var QUAD_SPECS = {
  // 440x320 = 140800 cells, exactly 8x the 160x110 base arena; 64 cycles.
  mega: { cols: 440, rows: 320, perQuadrant: 16, border: 10 },
  // 880x640 = 563200 cells, exactly 4x the mega arena (32x base); 128 cycles,
  // with a chunky outer frame befitting the sprawl.
  giga: { cols: 880, rows: 640, perQuadrant: 32, border: 28 },
  // 1760x1280 = 2252800 cells, exactly 4x the giga arena (128x base); 512
  // cycles, 128 per chamber, with a massive outer frame for the colossal sprawl.
  tera: { cols: 1760, rows: 1280, perQuadrant: 128, border: 56 }
};
var PERSONALITIES = [
  {
    id: "balanced",
    label: "BALANCED",
    code: "BAL",
    blurb: "All-rounder \u2014 the standard skill profile, no special leanings."
  },
  {
    id: "hunter",
    label: "HUNTER",
    code: "HUN",
    blurb: "Killer \u2014 lives only to track down rivals across the arena and gun them down."
  },
  {
    id: "packer",
    label: "PACKER",
    code: "PAK",
    blurb: "Tightest fit \u2014 hugs walls and its own trail to pack the most compact coil."
  },
  {
    id: "runner",
    label: "RUNNER",
    code: "RUN",
    blurb: "Speed-demon \u2014 laser-straight long runs at full sprint, turns only when forced."
  },
  {
    id: "survivor",
    label: "SURVIVOR",
    code: "SUR",
    blurb: "Pacifist \u2014 never attacks, hoards open space, only blasts an exit when truly cornered."
  },
  {
    id: "demolisher",
    label: "DEMOLISH",
    code: "DEM",
    blurb: "Wall-breaker \u2014 blasts walls open constantly, sprints, and fights with abandon."
  },
  {
    id: "roamer",
    label: "ROAMER",
    code: "ROM",
    blurb: "Explorer \u2014 ranges wide across open arena claiming fresh territory."
  },
  {
    id: "ambusher",
    label: "AMBUSH",
    code: "AMB",
    blurb: "Stalker \u2014 shadows the nearest rival then cuts across its path to force a crash."
  }
];
var PALETTE = [
  { name: "CYAN", color: "#55ffff" },
  { name: "YELLOW", color: "#ffff55" },
  { name: "RED", color: "#ff5555" },
  { name: "GREEN", color: "#55ff55" },
  { name: "MAGENTA", color: "#ff55ff" },
  { name: "WHITE", color: "#ffffff" },
  { name: "AZURE", color: "#5577ff" },
  { name: "ORANGE", color: "#ffaa00" },
  { name: "LIME", color: "#aaff00" },
  { name: "ROSE", color: "#ff77aa" }
];
var HUMAN_KEYS = [
  {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    sprint: "ShiftRight",
    shoot: "Slash"
  },
  {
    up: "KeyW",
    down: "KeyS",
    left: "KeyA",
    right: "KeyD",
    sprint: "ShiftLeft",
    shoot: "Space"
  }
];

// src/player.ts
var CHARGE_MAX = 100;
var Player = class {
  id;
  name;
  color;
  headColor;
  type;
  keys;
  // AI only: the driving character and the resolved behaviour profile (difficulty
  // baseline transformed by that character). Set in Game.newMatch; null for humans.
  personality;
  aiProfile = null;
  x = 0;
  y = 0;
  dir = 1;
  alive = true;
  wins = 0;
  length = 1;
  // cells laid this round (the trail length)
  // Match totals, accumulated across every round (like wins) and shown on the
  // scoreboard. kills counts rivals destroyed by this cycle's rockets (self-kills
  // don't count); blocksDestroyed counts WALL cells its blasts have cleared.
  kills = 0;
  blocksDestroyed = 0;
  // buffered turns: applied one per step so fast right->down isn't dropped
  inputQueue = [];
  // per-player step timing (independent speeds / sprint)
  baseInterval;
  acc = 0;
  sprint = false;
  // AI only: steps left to commit to driving straight after blasting an escape
  // hole, so the bot actually punches through the wall instead of curling back
  // along it and re-trapping. Counts down each AI step.
  escapeSteps = 0;
  // Set the step a rocket is fired (see Game.tryShoot), read+cleared by aiSprint:
  // a cycle must NOT sprint the frame it shoots. Sprinting advances two cells and
  // lays trail in the cell its freshly-launched rocket needs to traverse, so the
  // rocket detonates point-blank on that own trail and kills the firer. Moving a
  // single cell keeps the rocket on the firer's (collision-exempt) head until it
  // outruns the cycle and flies clear.
  firedThisStep = false;
  // AI only: steps left before the bot re-runs its full (expensive) steering
  // scan. Between full scans it coasts on its last heading as long as the cell
  // ahead stays clear — a bot moves one cell per step, so a plan stays good for
  // a few steps. Spread across bots so they don't all replan on the same tick.
  // See Game.aiThink / AI_THINK_PERIOD.
  aiCooldown = 0;
  // weapon charge (0..CHARGE_MAX)
  charge = CHARGE_MAX;
  constructor(id, name, color, type, baseInterval, keys) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.headColor = brighten(color, 0.55);
    this.type = type;
    this.baseInterval = baseInterval;
    this.keys = keys;
  }
  get interval() {
    return this.sprint ? this.baseInterval * 0.5 : this.baseInterval;
  }
  get charged() {
    return this.charge >= CHARGE_MAX;
  }
  spawn(x, y, dir) {
    this.x = x;
    this.y = y;
    this.dir = dir;
    this.inputQueue.length = 0;
    this.alive = true;
    this.acc = 0;
    this.sprint = false;
    this.escapeSteps = 0;
    this.firedThisStep = false;
    this.aiCooldown = 0;
    this.charge = CHARGE_MAX;
    this.length = 1;
  }
  // the heading the next queued turn is measured against: the tail of the
  // buffer if turns are pending, otherwise the live heading. Relative
  // (turn-left / turn-right) controls steer against this so rapid taps chain
  // correctly instead of being rejected as duplicates of the live heading.
  get pendingDir() {
    return this.inputQueue.length > 0 ? this.inputQueue[this.inputQueue.length - 1] : this.dir;
  }
  // queue a turn, validated against the last intended direction so we never
  // queue a reversal or a duplicate
  queueTurn(dir) {
    const ref = this.pendingDir;
    if (dir === ref || dir === opposite(ref)) return;
    if (this.inputQueue.length < 3) this.inputQueue.push(dir);
  }
  // pull the next buffered turn into the live heading (called once per step)
  applyNextTurn() {
    if (this.inputQueue.length > 0) {
      this.dir = this.inputQueue.shift();
    }
  }
};

// src/maps.ts
function mirror4(cols, rows, rects) {
  const out = [];
  for (const [x, y, w, h] of rects) {
    out.push([x, y, w, h]);
    out.push([cols - x - w, y, w, h]);
    out.push([x, rows - y - h, w, h]);
    out.push([cols - x - w, rows - y - h, w, h]);
  }
  return out;
}
var MAPS = [
  {
    // A central cross with an open square at its heart.
    id: "cross",
    name: "CROSS",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 2, cy - 26, 4, 18],
        // upper arm of the vertical bar
        [cx - 26, cy - 2, 18, 4]
        // left arm of the horizontal bar
      ]);
    }
  },
  {
    // Four solid blocks around a small central pillar.
    id: "boxes",
    name: "BOXES",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 22, cy - 18, 9, 9],
        // one quadrant block (mirrored to all four)
        [cx - 3, cy - 3, 6, 6]
        // centre pillar
      ]);
    }
  },
  {
    // A rectangular frame with a gap centred on each side.
    id: "ring",
    name: "RING",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 25, cy - 22, 18, 3],
        // top segment of one corner
        [cx - 25, cy - 22, 3, 18]
        // left segment of one corner
      ]);
    }
  },
  {
    // A stepped diamond outline around a centre dot.
    id: "diamond",
    name: "DIAMOND",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      const rects = [[cx - 2, cy - 2, 4, 4]];
      for (let k = 0; k <= 6; k++) {
        rects.push([cx - 2 - 4 * k, cy - 26 + 4 * k, 4, 4]);
      }
      return mirror4(cols, rows, rects);
    }
  },
  {
    // Procedurally generated: a fresh scatter of random blocks every round.
    // Obstacles are authored in the upper-left quadrant and mirrored (mirror4)
    // so the layout stays 4-fold symmetric and fair, kept inside the spawn ring
    // and clear of the centre cross so spawns and their run-up stay open.
    id: "random",
    name: "RANDOM",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      const R = Math.floor(Math.min(cols, rows) * 0.26);
      const gap = 3;
      const rects = [];
      const count = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < count; i++) {
        const w = 3 + Math.floor(Math.random() * 8);
        const h = 3 + Math.floor(Math.random() * 8);
        const x = cx - gap - w - Math.floor(Math.random() * (R - w + 1));
        const y = cy - gap - h - Math.floor(Math.random() * (R - h + 1));
        rects.push([x, y, w, h]);
      }
      return mirror4(cols, rows, rects);
    }
  }
];
var DEFAULT_MAP_ID = MAPS[0].id;

// src/ai/constants.ts
var WALL = -2;
var EMPTY = -1;
var DEATH = -3;
var OPEN_RADIUS = 3;
var PF_RANGE = 90;
var PF_NODES = 14e3;
var PF_WALL_COST = 6;
var PF_PATH_BONUS = 1e6;
var PF_MIN_FLOOD = 4;
var PF_MAX_WALL_RUN = 10;
var PF_WALL_RUN_PENALTY = 1e5;
var HUNT_MIN_FLOOD = 60;
var SPATIAL_TILE = 16;
var AI_THINK_PERIOD = 3;
var AI_STAGGER_MIN_CYCLES = 256;
var COAST_RUNWAY = 6;
var COAST_OPEN_MIN = 40;

// src/parallel/layout.ts
var CTRL = {
  GENERATION: 0,
  // bumped by main each think pass; workers park on it changing
  PENDING: 1,
  // workers still owing completion this pass (main spins to 0)
  DUE_COUNT: 2,
  // number of valid entries in the shared dueList this pass
  STOP: 3,
  // set to 1 to tell parked workers to exit their loop
  LEN: 4
  // total Int32 slots
};
function makeControlSab() {
  return new SharedArrayBuffer(CTRL.LEN * Int32Array.BYTES_PER_ELEMENT);
}

// src/parallel/worldbuf.ts
function tilesFor(cols, rows) {
  return {
    tilesX: Math.max(1, Math.ceil(cols / SPATIAL_TILE)),
    tilesY: Math.max(1, Math.ceil(rows / SPATIAL_TILE))
  };
}
var SAB = (bytes) => new SharedArrayBuffer(bytes);
function allocWorldSabs(cols, rows, n) {
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
    dueList: SAB(n * I32)
  };
}
function viewWorld(sabs, cols, rows, n) {
  const { tilesX, tilesY } = tilesFor(cols, rows);
  const world = {
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
    profPathfind: new Uint8Array(sabs.profPathfind)
  };
  return { world, dueList: new Int32Array(sabs.dueList) };
}

// src/parallel/coordinator.ts
var SPIN_TIMEOUT_MS = 250;
var ParallelAi = class {
  workerCount;
  workers = [];
  control;
  controlSab;
  sabs = null;
  cols = 0;
  rows = 0;
  n = 0;
  readyCount = 0;
  // main-thread views over the shared world (Game writes the snapshot here)
  world = null;
  dueList = null;
  constructor(workerCount) {
    this.workerCount = workerCount;
    this.controlSab = makeControlSab();
    this.control = new Int32Array(this.controlSab);
  }
  // True once every worker has set up and parked — until then the caller must use
  // the single-threaded path (dispatching before workers park would deadlock).
  isReady() {
    return this.world !== null && this.readyCount >= this.workerCount;
  }
  matches(cols, rows, n) {
    return this.cols === cols && this.rows === rows && this.n === n;
  }
  // (Re)allocate shared buffers for a new match shape and respawn the worker pool.
  // Matches are infrequent, so a clean teardown/respawn avoids the "re-init a
  // parked worker" problem (a worker blocked in Atomics.wait can't read messages).
  resize(cols, rows, n) {
    this.dispose();
    this.cols = cols;
    this.rows = rows;
    this.n = n;
    this.readyCount = 0;
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
      w.onmessage = (ev) => {
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
        count: this.workerCount
      });
      this.workers.push(w);
    }
  }
  // Run one think pass over dueList[0..dueCount). Caller must have written the
  // due indices into this.dueList and the SoA snapshot into this.world first.
  // Blocks (busy-spin) until every worker reports done. No-op if not ready.
  think(dueCount) {
    if (!this.isReady() || dueCount <= 0) return;
    const ctrl = this.control;
    Atomics.store(ctrl, CTRL.DUE_COUNT, dueCount);
    Atomics.store(ctrl, CTRL.PENDING, this.workerCount);
    Atomics.add(ctrl, CTRL.GENERATION, 1);
    Atomics.notify(ctrl, CTRL.GENERATION, this.workerCount);
    const deadline = performance.now() + SPIN_TIMEOUT_MS;
    let guard = 0;
    while (Atomics.load(ctrl, CTRL.PENDING) !== 0) {
      if ((++guard & 1023) === 0 && performance.now() > deadline) {
        console.warn("[parallel] think join timed out; degrading this frame");
        break;
      }
    }
  }
  dispose() {
    if (this.workers.length) {
      Atomics.store(this.control, CTRL.STOP, 1);
      Atomics.add(this.control, CTRL.GENERATION, 1);
      Atomics.notify(this.control, CTRL.GENERATION, this.workerCount);
      for (const w of this.workers) w.terminate();
      this.workers = [];
    }
    this.readyCount = 0;
  }
};

// src/parallel/caps.ts
function detectParallel() {
  if (typeof SharedArrayBuffer === "undefined")
    return { available: false, workerCount: 0, reason: "SharedArrayBuffer undefined" };
  if (typeof self !== "undefined" && self.crossOriginIsolated !== true)
    return { available: false, workerCount: 0, reason: "not crossOriginIsolated (COOP/COEP headers missing)" };
  if (typeof Worker === "undefined")
    return { available: false, workerCount: 0, reason: "Worker unavailable" };
  const cores = navigator.hardwareConcurrency || 4;
  return { available: true, workerCount: Math.max(1, cores - 1), reason: "ok" };
}

// src/game.ts
var BORDER = 10;
var SPEED_INTERVAL = {
  slow: 110,
  normal: 80,
  fast: 56
};
function slotColor(i) {
  if (i < PALETTE.length) return PALETTE[i].color;
  const hue = (i - PALETTE.length) * 137.508 % 360;
  return hslToHex(hue, 0.7, 0.62);
}
function botName(i) {
  if (i < PALETTE.length) return PALETTE[i].name.slice(0, 3) + "-BOT";
  return "BOT-" + (i + 1);
}
var CHARGE_RATE = CHARGE_MAX / 3e3;
var PROJ_INTERVAL = 11;
var PROJ_RANGE = 260;
var BLAST = 5;
var BLAST_RADIUS = Math.floor(BLAST / 2);
var DEATH_BLAST = 5;
var EXPLOSION_MS = 280;
var SPEC_ZOOM_MAX = 2.2;
var SPEC_ZOOM_STEP = 1.18;
var SPEC_PAN_FRAC = 0.15;
var SPEC_ZOOM_OUT_X = 5;
var SPEC_MAX_VISIBLE_CELLS = 5e5;
var ESCAPE_STEPS = 7;
var SPRINT_RUNWAY = 16;
var DODGE_HORIZON = 36;
var DODGE_PREDICT = 24;
var AI_DIFFICULTY = {
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
    jitter: 16
  },
  normal: {
    aimRange: 14,
    aimTake: 0.7,
    lead: true,
    escape: true,
    escapeSpace: 70,
    openRate: 0.08,
    flood: 140,
    open: 0.5,
    hunt: 4,
    straight: 5,
    jitter: 7
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
    jitter: 3
  },
  insane: {
    aimRange: 48,
    aimTake: 1,
    lead: true,
    escape: true,
    escapeSpace: 180,
    openRate: 0.12,
    flood: 360,
    open: 0.9,
    hunt: 9,
    straight: 6,
    jitter: 1
  },
  // Beyond insane. Arena-wide sight, never declines a clean shot, leads
  // movement, and relentlessly hunts charged rivals. It bails out of even a
  // faint pocket (huge escapeSpace) by blasting an escape hole, and with very
  // deep flood-fill look-ahead, a hard pull toward open space, and zero steering
  // noise it almost never boxes itself in.
  expert: {
    aimRange: 999,
    aimTake: 1,
    lead: true,
    escape: true,
    escapeSpace: 400,
    openRate: 0.2,
    flood: 800,
    open: 1.4,
    hunt: 14,
    straight: 6,
    jitter: 0
  },
  // Unfair on purpose — close to impossible to kill. Everything expert does,
  // turned up: it panics out of even a sliver of a pocket (massive escapeSpace),
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
    flood: 2e3,
    open: 2.6,
    hunt: 20,
    straight: 6,
    jitter: 0,
    alwaysSprint: true
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
    pacifist: false
  }
};
var clamp01 = (v) => Math.max(0, Math.min(1, v));
var PERSONALITY_STYLE = {
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
    seekRange: 1e5,
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
    escapeSpace: Math.round(b.escapeSpace * 1.3)
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
    escapeSpace: Math.round(b.escapeSpace * 0.7)
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
    alwaysSprint: true
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
    openRate: 0
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
    alwaysSprint: true
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
    jitter: b.jitter * 0.6
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
    escapeSpace: Math.round(b.escapeSpace * 0.9)
  })
};
function buildProfile(diff, personality) {
  return PERSONALITY_STYLE[personality](AI_DIFFICULTY[diff]);
}
var PERSONALITY_CODE = Object.fromEntries(
  PERSONALITIES.map((p) => [p.id, p.code])
);
var ALL_PERSONALITIES = PERSONALITIES.map((p) => p.id);
var Game = class {
  // grid dimensions can change between matches (see resize / newMatch)
  cols;
  rows;
  cell;
  viewW;
  viewH;
  worldW;
  worldH;
  grid;
  // direction the trail was laid in at each cell (a Dir), used to orient the
  // chevron arrows when drawing the line. Only meaningful where grid >= 0.
  dirs;
  // persistent scorch marks: 1 where an explosion has happened. Purely visual,
  // does not block movement.
  scorch;
  ctx;
  cb;
  bgPattern;
  // hunter pathfinder scratch (lazily sized to the grid; see pathToward). The
  // stamp/gen pair lets us treat dist/next as "empty" each query without clearing
  // the whole grid — a cell's value is only valid when its stamp matches pfGen.
  pfDist = null;
  pfStamp = null;
  pfNext = null;
  pfHeap = null;
  pfGen = 0;
  players = [];
  projectiles = [];
  explosions = [];
  views = [];
  // living-cycle count, maintained incrementally as cycles die (set to the full
  // roster each startRound, decremented on every death). Lets the hot per-frame
  // and per-tick paths read a count without re-filtering the whole roster — see
  // checkRoundOver and main.ts's frame loop.
  aliveCount = 0;
  state = "idle";
  winnerName = null;
  winner = null;
  // true when the round was called early by a downed human bailing out rather
  // than fought to a natural finish — lets the results screen say so and skips
  // crowning a winner.
  endedEarly = false;
  currentMap = MAPS[0];
  aiDifficulty = "normal";
  gameMode = "classic";
  // the active quad-mode layout (mega/giga), or null in classic mode
  quadSpec = null;
  // flood-fill scratch (stamped to avoid per-call clears)
  stamp;
  stampGen = 0;
  // reused BFS frontier for floodCount, sized to the whole grid (a flood can
  // touch at most every cell once). Preallocated so the hot path never allocates
  // — the old per-call `number[]` queue was ~1.5k array allocations per frame.
  floodQueue;
  // Head map: which cycle's HEAD sits on each cell this snapshot (stamped like the
  // flood scratch). Lets enemyInLineOfFire test "is a rival head on my firing line"
  // in O(1) per cell instead of scanning every cycle — turning that shot check from
  // O(range*N) into O(range). Built in rebuildSpatial, and only for large fields
  // (small fields keep the exact live scan, so their shooting is unchanged).
  headStamp;
  headOwner;
  headGen = 0;
  // spatial bucket grid for nearestRival (rebuilt each frame; see ensureSpatial /
  // rebuildSpatial / nearestRival). CSR layout: tileStart[t]..tileStart[t+1] index
  // into tileItems, which holds the player indices bucketed into tile t.
  tilesX = 0;
  tilesY = 0;
  tileStart = new Int32Array(1);
  tileCursor = new Int32Array(0);
  tileItems = new Int32Array(0);
  // Parallel AI (Web Worker pool over SharedArrayBuffer). null when the page can't
  // support it (not cross-origin isolated, no SAB) — then we always run serial.
  // Engaged only for large fields (see parallelEngaged). caps is kept for the HUD.
  parallel = null;
  parallelCaps;
  // per-cycle step counter for the parallel round loop (reused per match)
  stepsTaken = new Int32Array(0);
  // last simulation step duration in ms (for the perf HUD)
  tickMs = 0;
  // per-player smooth trail gradients in local cell space (reused per cell):
  //   v = vertical segment  (bright left -> dark right)
  //   h = horizontal segment (bright top -> dark bottom)
  //   d = corner/elbow       (bright top-left -> dark bottom-right)
  // a single top-left light source keeps straight runs and bends continuous.
  trailGrads = [];
  constructor(canvas, cols, rows, cell, viewW, viewH, cb2) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.viewW = viewW;
    this.viewH = viewH;
    this.worldW = cols * cell;
    this.worldH = rows * cell;
    this.cb = cb2;
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
    this.parallelCaps = detectParallel();
    this.parallel = this.parallelCaps.available ? new ParallelAi(this.parallelCaps.workerCount) : null;
  }
  // Re-dimension the world to a new cell grid, reallocating every per-cell
  // buffer. No-op when the size is unchanged. Always followed by startRound,
  // which clears and rebuilds the grid contents.
  resize(cols, rows) {
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
  wrapX(x) {
    return (x % this.cols + this.cols) % this.cols;
  }
  wrapY(y) {
    return (y % this.rows + this.rows) % this.rows;
  }
  // The world is a torus: every coordinate is valid and wraps to the far edge,
  // so callers no longer bounds-check — they just read/write through here.
  idx(x, y) {
    return this.wrapY(y) * this.cols + this.wrapX(x);
  }
  isFree(x, y) {
    return this.grid[this.idx(x, y)] === EMPTY;
  }
  // Shift cell coordinate `coord` by whole worlds so it lands nearest the centre
  // of a camera window, used to draw torus-wrapped entities in the right copy.
  wrapNearCell(coord, camPx, viewSize, span) {
    const centerCell = (camPx + viewSize / 2) / this.cell;
    return coord - span * Math.round((coord - centerCell) / span);
  }
  // Whole-world shifts (in cells, multiples of `span`) that place a cell at
  // `coord` somewhere inside the framed window [camPx, camPx+viewSize) on this
  // axis. Almost always one value — but when the spectator zooms out past a
  // single world copy the torus tiles into view, so an entity must be drawn in
  // each visible copy. A 1-cell margin keeps an entity straddling the edge.
  visibleShifts(coord, camPx, viewSize, span) {
    const cell = this.cell;
    const start = camPx / cell - 1;
    const end = (camPx + viewSize) / cell + 1;
    const nLo = Math.ceil((start - coord) / span);
    const nHi = Math.floor((end - coord) / span);
    const out = [];
    for (let n = nLo; n <= nHi; n++) out.push(n * span);
    return out;
  }
  // ---- match setup -------------------------------------------------------
  newMatch(config2) {
    const base = SPEED_INTERVAL[config2.speed];
    this.gameMode = config2.mode ?? "classic";
    this.quadSpec = QUAD_SPECS[this.gameMode] ?? null;
    const dims = this.quadSpec ?? MAP_DIMENSIONS[config2.size] ?? MAP_DIMENSIONS.small;
    this.resize(dims.cols, dims.rows);
    this.currentMap = MAPS.find((m) => m.id === config2.map) ?? MAPS[0];
    this.aiDifficulty = config2.difficulty ?? "normal";
    this.players = [];
    const total = this.quadSpec ? this.quadSpec.perQuadrant * 4 : null;
    const humans = total ? Math.min(config2.humans, total) : config2.humans;
    const ai = total ? total - humans : config2.ai;
    let pi = 0;
    const configs = [];
    for (let h = 0; h < humans; h++) {
      const keys = humans === 1 ? { ...HUMAN_KEYS[h], sprint: "ShiftLeft", shoot: "Space" } : HUMAN_KEYS[h];
      configs.push({
        name: `P${h + 1}`,
        color: slotColor(pi),
        type: "human",
        keys
      });
      pi++;
    }
    const personalities = this.resolveRoster(config2.roster, ai);
    const charCount = {};
    for (let a = 0; a < ai; a++) {
      const persona = personalities[a];
      const n = charCount[persona] = (charCount[persona] ?? 0) + 1;
      configs.push({
        name: persona === "balanced" ? botName(pi) : `${PERSONALITY_CODE[persona]}${n}`,
        color: slotColor(pi),
        type: "ai",
        personality: persona
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
    const cell = this.cell;
    this.trailGrads = this.players.map((p) => {
      const hi = brighten(p.color, 0.62);
      const mid = p.color;
      const lo = darken(p.color, 0.5);
      const v = this.ctx.createLinearGradient(0, 0, cell, 0);
      const h = this.ctx.createLinearGradient(0, 0, 0, cell);
      const d = this.ctx.createLinearGradient(0, 0, cell, cell);
      for (const g2 of [v, h, d]) {
        g2.addColorStop(0, hi);
        g2.addColorStop(0.5, mid);
        g2.addColorStop(1, lo);
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
  setupParallel() {
    const par = this.parallel;
    if (!par) return;
    const n = this.players.length;
    if (n < AI_STAGGER_MIN_CYCLES) return;
    if (!par.matches(this.cols, this.rows, n)) par.resize(this.cols, this.rows, n);
    const world = par.world;
    if (!world) return;
    this.grid = world.grid;
    this.stepsTaken = new Int32Array(n);
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
    }
  }
  // build split-screen views, one per human player
  setupViews() {
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
        free: false
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
          free: false
        });
      });
    }
  }
  startRound() {
    this.grid.fill(EMPTY);
    this.scorch.fill(0);
    this.projectiles = [];
    this.explosions = [];
    const border = this.quadSpec?.border ?? BORDER;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (x < border || x >= this.cols - border || y < border || y >= this.rows - border) {
          this.grid[this.idx(x, y)] = WALL;
        }
      }
    }
    const spawns = this.quadSpec ? this.buildQuadArena(this.quadSpec) : this.buildClassicArena();
    this.players.forEach((p, i) => {
      const s = spawns[i];
      for (let k = 1; k <= 6; k++) {
        const ax = s.x + DELTA[s.dir].x * k;
        const ay = s.y + DELTA[s.dir].y * k;
        this.grid[this.idx(ax, ay)] = EMPTY;
      }
      p.spawn(s.x, s.y, s.dir);
      p.aiCooldown = p.id % AI_THINK_PERIOD;
      this.grid[this.idx(s.x, s.y)] = p.id;
      this.dirs[this.idx(s.x, s.y)] = s.dir;
    });
    for (const v of this.views) {
      v.spectate = null;
      v.zoom = 1;
      v.free = false;
      const t = v.player;
      v.camx = (t.x + 0.5) * this.cell - v.rw / 2;
      v.camy = (t.y + 0.5) * this.cell - v.rh / 2;
    }
    this.aliveCount = this.players.length;
    this.winnerName = null;
    this.winner = null;
    this.endedEarly = false;
    this.state = "playing";
  }
  // Lay out the classic single-arena round: stamp the selected map's obstacles
  // over the whole interior, then return one spawn per player spaced evenly on a
  // ring around the world centre, each facing inward.
  buildClassicArena() {
    const loX = BORDER;
    const hiX = this.cols - BORDER - 1;
    const loY = BORDER;
    const hiY = this.rows - BORDER - 1;
    const cx = this.cols / 2;
    const cy = this.rows / 2;
    const radius = Math.min(hiX - loX, hiY - loY) * 0.42;
    const total = this.players.length;
    const ringCap = Math.floor(2 * Math.PI * radius / 3);
    const span = Math.min(hiX - loX, hiY - loY) / 2;
    const spawns = total <= ringCap ? this.players.map(
      (_, i) => this.ringSpawn(i, total, cx, cy, radius, loX, hiX, loY, hiY)
    ) : this.ringFill(total, cx, cy, span, loX, hiX, loY, hiY);
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
  buildQuadArena(spec) {
    const B = spec.border;
    const DIV = BORDER;
    const TUN = 7;
    const vx0 = Math.floor(this.cols / 2) - Math.floor(DIV / 2);
    const hy0 = Math.floor(this.rows / 2) - Math.floor(DIV / 2);
    for (let y = 0; y < this.rows; y++) {
      for (let d = 0; d < DIV; d++) this.grid[this.idx(vx0 + d, y)] = WALL;
    }
    for (let x = 0; x < this.cols; x++) {
      for (let d = 0; d < DIV; d++) this.grid[this.idx(x, hy0 + d)] = WALL;
    }
    const quads = [
      { ox: B, oy: B, ex: vx0, ey: hy0 },
      // TL
      { ox: vx0 + DIV, oy: B, ex: this.cols - B, ey: hy0 },
      // TR
      { ox: B, oy: hy0 + DIV, ex: vx0, ey: this.rows - B },
      // BL
      { ox: vx0 + DIV, oy: hy0 + DIV, ex: this.cols - B, ey: this.rows - B }
      // BR
    ];
    const topMidY = Math.floor((B + hy0) / 2);
    const botMidY = Math.floor((hy0 + DIV + this.rows - B) / 2);
    this.carve(vx0, topMidY - TUN, DIV, 2 * TUN + 1);
    this.carve(vx0, botMidY - TUN, DIV, 2 * TUN + 1);
    const leftMidX = Math.floor((B + vx0) / 2);
    const rightMidX = Math.floor((vx0 + DIV + this.cols - B) / 2);
    this.carve(leftMidX - TUN, hy0, 2 * TUN + 1, DIV);
    this.carve(rightMidX - TUN, hy0, 2 * TUN + 1, DIV);
    const spawns = [];
    for (let q = 0; q < quads.length; q++) {
      const { ox, oy, ex, ey } = quads[q];
      const qw = ex - ox;
      const qh = ey - oy;
      const qcx = (ox + ex) / 2;
      const qcy = (oy + ey) / 2;
      for (const [px, py, w, h] of this.currentMap.build(qw, qh)) {
        this.fillRect(ox + px, oy + py, w, h);
      }
      for (const sp of this.ringFill(
        spec.perQuadrant,
        qcx,
        qcy,
        Math.min(qw, qh) / 2,
        ox,
        ex - 1,
        oy,
        ey - 1
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
  ringFill(n, cx, cy, span, loX, hiX, loY, hiY) {
    const out = [];
    const rings = Math.max(1, Math.round(Math.sqrt(n / 3)));
    const minR = rings === 1 ? span * 0.4 : span * 0.32;
    const maxR = span * 0.92;
    const radii = [];
    for (let r = 0; r < rings; r++) {
      radii.push(rings === 1 ? minR : minR + (maxR - minR) * r / (rings - 1));
    }
    const weight = radii.reduce((s, r) => s + r, 0);
    const raw = radii.map((r) => n * r / weight);
    const counts = raw.map(Math.floor);
    let left = n - counts.reduce((s, c) => s + c, 0);
    radii.map((_, r) => r).sort((a, b) => raw[b] - raw[a] - (counts[b] - counts[a])).forEach((r) => {
      if (left-- > 0) counts[r]++;
    });
    for (let r = 0; r < rings; r++) {
      const offset = r * 2.39996;
      for (let k = 0; k < counts[r]; k++) {
        out.push(
          this.ringSpawn(k, counts[r], cx, cy, radii[r], loX, hiX, loY, hiY, offset)
        );
      }
    }
    return out;
  }
  // One spawn on a ring of `count` points around (cx, cy): slot `i` sits at its
  // angle and radius, clamped inside [loX..hiX] × [loY..hiY], facing the centre.
  ringSpawn(i, count, cx, cy, radius, loX, hiX, loY, hiY, angOffset = 0) {
    const ang = i / count * Math.PI * 2 - Math.PI / 2 + angOffset;
    let sx = Math.round(cx + Math.cos(ang) * radius);
    let sy = Math.round(cy + Math.sin(ang) * radius);
    sx = Math.max(loX + 1, Math.min(hiX - 1, sx));
    sy = Math.max(loY + 1, Math.min(hiY - 1, sy));
    const dx = cx - sx;
    const dy = cy - sy;
    const dir = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 1 : 3 : dy > 0 ? 2 : 0;
    return { x: sx, y: sy, dir };
  }
  // clear a w×h block back to EMPTY (used to punch tunnels through dividers)
  carve(px, py, w, h) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        this.grid[this.idx(px + xx, py + yy)] = EMPTY;
      }
    }
  }
  // stamp a w×h block of WALL, clipped to the arena interior
  fillRect(px, py, w, h) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        this.grid[this.idx(px + xx, py + yy)] = WALL;
      }
    }
  }
  // a cycle just died at (cx, cy): clear a 5x5 block (trails, pillars, walls,
  // old death marks), then stamp the centre 3x3 as destructible DEATH markers
  // and fire off a 5x5 explosion flash. Outer walls are left intact.
  placeDeathMark(cx, cy) {
    const half = Math.floor(DEATH_BLAST / 2);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
          this.grid[this.idx(x, y)] = DEATH;
        } else {
          this.grid[this.idx(x, y)] = EMPTY;
        }
      }
    }
    this.spawnExplosion(cx - half, cy - half, DEATH_BLAST);
  }
  // push an explosion flash whose top-left is (x0, y0) and that spans
  // `size` x `size` cells, and leave a persistent gray scorch over its
  // footprint. The scorch is purely visual and never blocks movement.
  spawnExplosion(x0, y0, size) {
    this.explosions.push({ x: x0, y: y0, size, age: 0, life: EXPLOSION_MS });
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        this.scorch[this.idx(x0 + dx, y0 + dy)] = 1;
      }
    }
  }
  // shift a world-pixel coordinate by whole worlds so it sits nearest `ref`;
  // keeps the camera from panning across the whole map when the target wraps
  nearestWrapPx(v, ref, world) {
    return v - world * Math.round((v - ref) / world);
  }
  // ---- input -------------------------------------------------------------
  steerHuman(p, dir) {
    p.queueTurn(dir);
  }
  tryShoot(p) {
    if (this.state !== "playing" || !p.alive || !p.charged) return;
    p.charge = 0;
    p.firedThisStep = true;
    this.projectiles.push({
      x: p.x,
      y: p.y,
      dir: p.dir,
      owner: p.id,
      color: p.color,
      range: PROJ_RANGE,
      acc: 0
    });
  }
  // ---- simulation --------------------------------------------------------
  update(dt) {
    if (this.state === "playing") {
      const t0 = performance.now();
      if (this.parallelEngaged()) this.updateParallel(dt);
      else this.updateSerial(dt);
      this.tickMs = performance.now() - t0;
    }
    this.updateCameras(dt);
  }
  // Whether the parallel path is actually driving the sim right now (for the HUD).
  get parallelLive() {
    return this.state === "playing" && this.parallelEngaged();
  }
  // True when the parallel AI path is usable this frame: the worker pool is up and
  // parked, the shared buffers match the current match, our grid IS the shared SAB
  // grid, and the field is big enough to be worth fanning out (same threshold that
  // gates staggering). Otherwise we run the proven single-threaded path.
  parallelEngaged() {
    const par = this.parallel;
    return par !== null && par.isReady() && par.world !== null && this.grid === par.world.grid && this.players.length >= AI_STAGGER_MIN_CYCLES;
  }
  // The original single-threaded simulation step (unchanged behaviour). Also the
  // fallback whenever the parallel path is unavailable.
  updateSerial(dt) {
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
  checkRoundOver() {
    const survival = this.players.length === 1;
    if (!survival && this.aliveCount <= 1 || survival && this.aliveCount === 0) {
      this.endRound(this.players.find((p) => p.alive) ?? null);
    }
  }
  stepPlayer(p) {
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
  applyMoveStep(p) {
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;
    if (!this.isFree(nx, ny)) {
      p.alive = false;
      this.aliveCount--;
      this.placeDeathMark(p.x, p.y);
      return;
    }
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
  updateParallel(dt) {
    const par = this.parallel;
    const world = par.world;
    const players = this.players;
    for (const p of players) {
      if (!p.alive) continue;
      p.charge = Math.min(CHARGE_MAX, p.charge + dt * CHARGE_RATE);
      p.acc += dt;
      this.stepsTaken[p.id] = 0;
    }
    for (let round = 0; round < 2; round++) {
      let anyDue = false;
      let dueAi = 0;
      const dueList = par.dueList;
      for (const p of players) {
        if (p.alive && this.stepsTaken[p.id] < 2 && p.acc >= p.interval) {
          anyDue = true;
          if (p.type === "ai") dueList[dueAi++] = p.id;
        }
      }
      if (!anyDue) break;
      this.snapshotWorld(world);
      par.think(dueAi);
      for (const p of players) {
        if (!(p.alive && this.stepsTaken[p.id] < 2 && p.acc >= p.interval)) continue;
        p.acc -= p.interval;
        if (p.type === "ai") {
          p.dir = world.pdir[p.id];
          p.aiCooldown = world.paiCooldown[p.id];
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
  snapshotWorld(world) {
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
  updateProjectiles(dt) {
    if (this.projectiles.length > 0) {
      const survivors = [];
      for (const pr of this.projectiles) {
        pr.acc += dt;
        let live = true;
        let steps = 0;
        const firer = this.players[pr.owner];
        while (live && pr.acc >= PROJ_INTERVAL && steps < 8) {
          pr.acc -= PROJ_INTERVAL;
          steps++;
          const nx = this.wrapX(pr.x + DELTA[pr.dir].x);
          const ny = this.wrapY(pr.y + DELTA[pr.dir].y);
          const g2 = this.grid[this.idx(nx, ny)];
          const onFirerHead = firer && firer.alive && nx === firer.x && ny === firer.y;
          if (g2 !== EMPTY && !onFirerHead) {
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
        if (live) survivors.push(pr);
      }
      this.projectiles = survivors;
    }
    if (this.explosions.length > 0) {
      for (const e of this.explosions) e.age += dt;
      this.explosions = this.explosions.filter((e) => e.age < e.life);
    }
  }
  // BLAST x BLAST blast centred near (cx,cy): clears trails + interior pillars
  // and kills any rival caught inside. Outer walls and the firer are spared.
  detonate(cx, cy, owner) {
    const firer = owner !== void 0 ? this.players[owner] : void 0;
    const x0 = cx - Math.floor(BLAST / 2);
    const y0 = cy - Math.floor(BLAST / 2);
    for (let dy = 0; dy < BLAST; dy++) {
      for (let dx = 0; dx < BLAST; dx++) {
        const i = this.idx(x0 + dx, y0 + dy);
        const g2 = this.grid[i];
        if (g2 >= 0 || g2 === WALL || g2 === DEATH) {
          if (firer) firer.blocksDestroyed++;
          this.grid[i] = EMPTY;
        }
      }
    }
    for (const p of this.players) {
      if (!p.alive) continue;
      const ddx = this.wrapX(p.x - x0);
      const ddy = this.wrapY(p.y - y0);
      if (ddx < BLAST && ddy < BLAST) {
        p.alive = false;
        this.aliveCount--;
        if (firer && p !== firer) firer.kills++;
        this.placeDeathMark(p.x, p.y);
      }
    }
    this.spawnExplosion(x0, y0, BLAST);
  }
  // True while at least one human pilot is still racing. Used to gate the
  // bail-out: a downed human can only call the round when no human is left
  // alive, so one dead player can't cut a still-racing teammate's round short.
  humansAlive() {
    return this.players.some((p) => p.type === "human" && p.alive);
  }
  // A downed human ends the round immediately instead of waiting for the bots
  // to fight it out. No winner is crowned — the match is simply called, and the
  // results screen notes it was ended early.
  endRoundEarly() {
    if (this.state !== "playing" || this.humansAlive()) return;
    this.endedEarly = true;
    this.endRound(null);
  }
  endRound(winner) {
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
  resolveRoster(roster2, n) {
    const out = [];
    if (!roster2 || roster2.mode === "uniform") {
      const p = roster2?.personality ?? "balanced";
      for (let i = 0; i < n; i++) out.push(p);
      return out;
    }
    if (roster2.mode === "random") {
      const pool = roster2.pool.length ? roster2.pool : ALL_PERSONALITIES;
      for (let i = 0; i < n; i++) {
        out.push(pool[Math.floor(Math.random() * pool.length)]);
      }
      return this.shuffle(out);
    }
    const entries = Object.entries(roster2.counts).filter(([, c]) => c > 0);
    const spec = entries.reduce((s, [, c]) => s + c, 0);
    if (spec === 0) {
      for (let i = 0; i < n; i++) out.push("balanced");
      return out;
    }
    for (const [p, c] of entries) {
      const k = spec === n ? c : Math.round(c / spec * n);
      for (let i = 0; i < k && out.length < n; i++) out.push(p);
    }
    for (let i = 0; out.length < n; i++) out.push(entries[i % entries.length][0]);
    out.length = n;
    return this.shuffle(out);
  }
  // in-place Fisher–Yates shuffle
  shuffle(a) {
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
  aiThink(p) {
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;
    const canCoast = this.players.length >= AI_STAGGER_MIN_CYCLES && p.aiCooldown > 0 && p.escapeSteps === 0 && this.clearAhead(p, COAST_RUNWAY) >= COAST_RUNWAY && this.openness(nx, ny, OPEN_RADIUS) >= COAST_OPEN_MIN;
    if (canCoast) {
      p.aiCooldown--;
    } else {
      p.dir = this.aiChoose(p);
      p.aiCooldown = AI_THINK_PERIOD;
    }
    this.aiAvoidDanger(p);
    this.aiMaybeShoot(p);
    this.aiSprint(p);
  }
  aiChoose(p) {
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    const cur = p.dir;
    const back = opposite(cur);
    if (p.escapeSteps > 0 && this.clearAhead(p, 2) >= 2) {
      return cur;
    }
    const target = cfg.hunt > 0 && (p.charged || cfg.stalk) ? this.nearestRival(p, cfg.seekRange ?? cfg.aimRange) : null;
    const pathDir = cfg.pathfind && target && this.manhattan(p, target) <= PF_RANGE ? this.pathToward(p, target) : null;
    let bestDir = cur;
    let bestScore = -Infinity;
    for (let d = 0; d < 4; d = d + 1) {
      if (d === back) continue;
      const nx = p.x + DELTA[d].x;
      const ny = p.y + DELTA[d].y;
      if (!this.isFree(nx, ny)) continue;
      const flood = this.floodCount(nx, ny, cfg.flood);
      let score = flood;
      if (pathDir !== null && d === pathDir && flood >= PF_MIN_FLOOD) {
        score += PF_PATH_BONUS;
      }
      score += this.openness(nx, ny, OPEN_RADIUS) * cfg.open;
      if (target && flood >= HUNT_MIN_FLOOD) {
        score += this.aimBonus(p, d, target) * cfg.hunt;
      }
      if (d === cur) score += cfg.straight;
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
  ensureSpatial() {
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
  rebuildSpatial() {
    this.ensureSpatial();
    const tx = this.tilesX;
    const nt = tx * this.tilesY;
    const start = this.tileStart;
    const cursor = this.tileCursor;
    const items = this.tileItems;
    const players = this.players;
    start.fill(0);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const t = (p.y / SPATIAL_TILE | 0) * tx + (p.x / SPATIAL_TILE | 0);
      start[t + 1]++;
    }
    for (let t = 0; t < nt; t++) start[t + 1] += start[t];
    for (let t = 0; t < nt; t++) cursor[t] = start[t];
    const buildHeads = players.length >= AI_STAGGER_MIN_CYCLES;
    const hgen = buildHeads ? ++this.headGen : 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const t = (p.y / SPATIAL_TILE | 0) * tx + (p.x / SPATIAL_TILE | 0);
      items[cursor[t]++] = i;
      if (buildHeads) {
        const c = p.y * this.cols + p.x;
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
  nearestRival(p, range) {
    const tx = this.tilesX;
    const ty = this.tilesY;
    const players = this.players;
    const start = this.tileStart;
    const items = this.tileItems;
    const ptx = p.x / SPATIAL_TILE | 0;
    const pty = p.y / SPATIAL_TILE | 0;
    const maxR = Math.min(
      Math.ceil(Math.max(tx, ty) / 2),
      Math.ceil(range / SPATIAL_TILE) + 1
    );
    let best = null;
    let bestD = range + 1;
    let foundRing = -1;
    for (let r = 0; r <= maxR; r++) {
      if (foundRing >= 0 && r > foundRing + 1) break;
      for (let dy = -r; dy <= r; dy++) {
        const edgeY = dy === -r || dy === r;
        for (let dx = -r; dx <= r; dx++) {
          if (!edgeY && dx !== -r && dx !== r) continue;
          const cx = ((ptx + dx) % tx + tx) % tx;
          const cy = ((pty + dy) % ty + ty) % ty;
          const t = cy * tx + cx;
          const e = start[t + 1];
          for (let k = start[t]; k < e; k++) {
            const q = players[items[k]];
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
  manhattan(a, b) {
    return Math.abs(this.wrapDelta(b.x - a.x, this.cols)) + Math.abs(this.wrapDelta(b.y - a.y, this.rows));
  }
  // Toroidal Chebyshev (chessboard) distance between two cells. Used to test
  // whether a cell falls inside the 3x3 death block a dying cycle leaves behind
  // (footprint radius 1), so the hunter can keep clear of it (see aiAvoidDanger).
  chebyshev(ax, ay, bx, by) {
    return Math.max(
      Math.abs(this.wrapDelta(bx - ax, this.cols)),
      Math.abs(this.wrapDelta(by - ay, this.rows))
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
  pathToward(p, t) {
    const n = this.cols * this.rows;
    if (!this.pfDist || this.pfDist.length !== n) {
      this.pfDist = new Float64Array(n);
      this.pfStamp = new Int32Array(n);
      this.pfNext = new Int8Array(n);
      this.pfHeap = new Float64Array(1 << 16);
    }
    const dist = this.pfDist;
    const stamp = this.pfStamp;
    const next = this.pfNext;
    const heap = this.pfHeap;
    const HMAX = heap.length;
    const gen = ++this.pfGen;
    let hlen = 0;
    const push = (key) => {
      if (hlen >= HMAX) return;
      let i = hlen++;
      heap[i] = key;
      while (i > 0) {
        const par = i - 1 >> 1;
        if (heap[par] <= heap[i]) break;
        const tmp = heap[par];
        heap[par] = heap[i];
        heap[i] = tmp;
        i = par;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap[--hlen];
      if (hlen > 0) {
        heap[0] = last;
        let i = 0;
        for (; ; ) {
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
    push(src);
    let pops = 0;
    let reached = false;
    while (hlen > 0 && pops < PF_NODES) {
      const key = pop();
      const cell = key % n;
      const cost = (key - cell) / n;
      if (stamp[cell] === gen && dist[cell] < cost) continue;
      if (cell === goal) {
        reached = true;
        break;
      }
      pops++;
      const cx = cell % this.cols;
      const cy = (cell - cx) / this.cols;
      const w = this.grid[cell] === EMPTY ? 1 : PF_WALL_COST;
      for (let d = 0; d < 4; d = d + 1) {
        const nx = this.wrapX(cx + DELTA[d].x);
        const ny = this.wrapY(cy + DELTA[d].y);
        const nc = this.idx(nx, ny);
        const extra = this.grid[nc] !== EMPTY && this.wallRunAhead(nx, ny, opposite(d)) > PF_MAX_WALL_RUN ? PF_WALL_RUN_PENALTY : 0;
        const nd = cost + w + extra;
        if (stamp[nc] !== gen || nd < dist[nc]) {
          stamp[nc] = gen;
          dist[nc] = nd;
          next[nc] = opposite(d);
          push(nd * n + nc);
        }
      }
    }
    if (!reached && stamp[goal] !== gen) return null;
    return next[goal];
  }
  // Steering reward for moving in `d` when hunting `t`: positive for closing the
  // gap, with a bigger payoff for a move that lands us heading straight down the
  // target's row or column (a firing line). Negative for moving away.
  aimBonus(p, d, t) {
    const dx = this.wrapDelta(t.x - p.x, this.cols);
    const dy = this.wrapDelta(t.y - p.y, this.rows);
    const v = DELTA[d];
    let b = v.x * Math.sign(dx) + v.y * Math.sign(dy);
    if (dx === 0 && d === (dy > 0 ? 2 : 0)) b += 3;
    if (dy === 0 && d === (dx > 0 ? 1 : 3)) b += 3;
    return b;
  }
  // Signed shortest delta on a wrapped axis of length `n` (e.g. -3 rather than
  // n-3), so direction maths works across the torus seam.
  wrapDelta(d, n) {
    let m = (d % n + n) % n;
    if (m > n / 2) m -= n;
    return m;
  }
  // Free cells in a (2r+1)^2 box centred on (cx, cy): a cheap local measure of
  // how boxed-in a move is. Used as the openness steering term (see aiChoose).
  // Hot path: wrap with a single branch per axis instead of idx()'s double
  // modulo, and index the grid directly. |dx|,|dy| <= r << cols/rows, and cx/cy
  // are near in-grid, so one add/sub always lands back in range.
  openness(cx, cy, r) {
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
  clearAhead(p, cap) {
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
  wallRunAhead(x, y, d) {
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
  aiSprint(p) {
    if (p.firedThisStep) {
      p.firedThisStep = false;
      p.sprint = false;
      return;
    }
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
  shotReach(p, ox, oy, dir, horizon) {
    const reach = BLAST_RADIUS + 1;
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
      if (this.grid[this.idx(cx, cy)] !== EMPTY) return -1;
    }
    return -1;
  }
  // The heading to break toward to clear a shot fired from (ox,oy) along `dir`:
  // perpendicular to the line, toward whichever side we're already off it (the
  // shorter hop out). Dead-centre defaults one way; aiAvoidDanger falls back to
  // the opposite side if that one's walled.
  breakDir(p, ox, oy, dir) {
    if (DELTA[dir].x !== 0) {
      return this.wrapDelta(p.y - oy, this.rows) >= 0 ? 2 : 0;
    }
    return this.wrapDelta(p.x - ox, this.cols) >= 0 ? 1 : 3;
  }
  // The heading `p` should break toward to escape the most imminent threat, or
  // null when it's safe. Two threats, nearest wins:
  //   A) a live enemy rocket already in the air bearing down on us, and
  //   B) an armed rival that has us lined up on its heading within DODGE_PREDICT —
  //      we step off the line BEFORE it fires, since a point-blank rocket flies
  //      far too fast to outrun once launched (this is what stops two hunters from
  //      charging muzzle-to-muzzle and trading kills).
  dodgeDir(p) {
    let escape = null;
    let bestSteps = Infinity;
    for (const pr of this.projectiles) {
      if (pr.owner === p.id) continue;
      const s = this.shotReach(p, pr.x, pr.y, pr.dir, Math.min(DODGE_HORIZON, pr.range));
      if (s >= 0 && s < bestSteps) {
        bestSteps = s;
        escape = this.breakDir(p, pr.x, pr.y, pr.dir);
      }
    }
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
  detonationCell(ox, oy, dir, horizon) {
    const dx = DELTA[dir].x;
    const dy = DELTA[dir].y;
    let cx = ox;
    let cy = oy;
    for (let i = 1; i <= horizon; i++) {
      cx = this.wrapX(cx + dx);
      cy = this.wrapY(cy + dy);
      if (this.grid[this.idx(cx, cy)] !== EMPTY) return { x: cx, y: cy };
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
  shotWouldSelfKill(p, range) {
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
  aiAvoidDanger(p) {
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    if (!cfg.dodge || p.escapeSteps > 0) return;
    const back = opposite(p.dir);
    const escape = this.dodgeDir(p);
    if (escape !== null) {
      let bestDir = null;
      let bestRoom = -1;
      for (const d of [escape, opposite(escape)]) {
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
      return;
    }
    const foe = this.nearestRival(p, 2);
    if (!foe) return;
    const nx = p.x + DELTA[p.dir].x;
    const ny = p.y + DELTA[p.dir].y;
    if (this.chebyshev(nx, ny, foe.x, foe.y) > 1) return;
    for (const d of [(p.dir + 1) % 4, (p.dir + 3) % 4]) {
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
  aiMaybeShoot(p) {
    if (!p.charged) return;
    const cfg = p.aiProfile ?? AI_DIFFICULTY[this.aiDifficulty];
    if (cfg.pacifist) {
      if (cfg.escape && this.selfBlastSafe(p) && this.obstacleAhead(p, 6) && this.openSpace(p, cfg.escapeSpace) < cfg.escapeSpace) {
        this.tryShoot(p);
        p.escapeSteps = ESCAPE_STEPS;
      }
      return;
    }
    const target = this.lineOfFireRival(p, cfg.aimRange, cfg.lead);
    if (target) {
      if (cfg.dodge && this.shotWouldSelfKill(p, cfg.aimRange)) return;
      if (Math.random() < cfg.aimTake) this.tryShoot(p);
      return;
    }
    if (cfg.breach && this.selfBlastSafe(p)) {
      const prey = this.nearestRival(p, cfg.seekRange ?? cfg.aimRange);
      if (prey && this.headingToward(p, prey) && this.obstacleAhead(p, 8)) {
        const within = this.manhattan(p, prey) <= PF_RANGE;
        const pd = within ? this.pathToward(p, prey) : null;
        const noWayAround = pd === null || pd === p.dir;
        if (noWayAround) {
          this.tryShoot(p);
          p.escapeSteps = ESCAPE_STEPS;
          return;
        }
      }
    }
    if (cfg.escape && this.selfBlastSafe(p) && this.obstacleAhead(p, 6) && this.openSpace(p, cfg.escapeSpace) < cfg.escapeSpace) {
      this.tryShoot(p);
      p.escapeSteps = ESCAPE_STEPS;
      return;
    }
    if (Math.random() < cfg.openRate && this.selfBlastSafe(p) && this.obstacleAhead(p, 4)) {
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
  selfBlastSafe(p) {
    const standoff = BLAST_RADIUS + 1;
    return this.clearAhead(p, standoff) >= standoff;
  }
  // True if driving straight ahead takes `p` closer to `t` (used so the hunter
  // only blasts a path when the obstacle is between it and its prey).
  headingToward(p, t) {
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
  lineOfFireRival(p, range, lead) {
    const dx = DELTA[p.dir].x;
    const dy = DELTA[p.dir].y;
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
          for (let d = 0; d < 4; d = d + 1) {
            const nb = this.idx(cx - DELTA[d].x, cy - DELTA[d].y);
            if (this.headStamp[nb] === gen && this.headOwner[nb] !== p.id && this.dirs[nb] === d) {
              return this.players[this.headOwner[nb]];
            }
          }
        }
        if (this.grid[c] !== EMPTY) return null;
      }
      return null;
    }
    for (let i = 1; i <= range; i++) {
      const cx = this.wrapX(p.x + dx * i);
      const cy = this.wrapY(p.y + dy * i);
      for (const q of this.players) {
        if (!q.alive || q.id === p.id) continue;
        if (q.x === cx && q.y === cy) return q;
        if (lead && this.wrapX(q.x + DELTA[q.dir].x) === cx && this.wrapY(q.y + DELTA[q.dir].y) === cy) {
          return q;
        }
      }
      const g2 = this.grid[this.idx(cx, cy)];
      if (g2 !== EMPTY) return null;
    }
    return null;
  }
  // Is there something the rocket can usefully detonate against within `range`
  // straight ahead? The rocket explodes on the first non-empty cell — its own
  // trail included — so any obstacle counts.
  obstacleAhead(p, range) {
    const dx = DELTA[p.dir].x;
    const dy = DELTA[p.dir].y;
    for (let i = 1; i <= range; i++) {
      const g2 = this.grid[this.idx(p.x + dx * i, p.y + dy * i)];
      if (g2 !== EMPTY) return true;
    }
    return false;
  }
  // Largest reachable open area over the cycle's legal turns, capped at `cap`
  // (cheap early-out — we only care whether it clears the "boxed in" threshold).
  openSpace(p, cap) {
    const back = opposite(p.dir);
    let best = 0;
    for (let d = 0; d < 4; d = d + 1) {
      if (d === back) continue;
      const nx = p.x + DELTA[d].x;
      const ny = p.y + DELTA[d].y;
      if (!this.isFree(nx, ny)) continue;
      best = Math.max(best, this.floodCount(nx, ny, cap));
      if (best >= cap) break;
    }
    return best;
  }
  floodCount(sx, sy, cap) {
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
  camTarget(v) {
    if (v.player.alive) return v.player;
    if (!v.spectate || !v.spectate.alive) {
      v.spectate = this.nextAlive(v.spectate, 1);
    }
    return v.spectate;
  }
  // The next living cycle after `current` (wrapping), stepping by `delta`
  // (+1 next, -1 previous). Returns the first survivor if `current` is null or
  // already dead, or null when nobody is alive.
  nextAlive(current, delta) {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length === 0) return null;
    const idx = current ? alive.indexOf(current) : -1;
    if (idx === -1) return alive[0];
    return alive[(idx + delta + alive.length) % alive.length];
  }
  // Switch a downed pilot's spectate camera to the next/previous live cycle.
  // Re-locks the camera onto that cycle (cancels any free-look pan). No-op while
  // the pilot is still alive or has no viewport.
  spectateStep(pilot, delta) {
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
  viewAt(sx, sy) {
    for (const v of this.views) {
      if (sx >= v.rx && sx < v.rx + v.rw && sy >= v.ry && sy < v.ry + v.rh) {
        return v;
      }
    }
    return null;
  }
  // Is the pilot owning the view under this canvas point a downed spectator? Lets
  // input only capture the wheel / drag when there's actually a view to control.
  canSpectateAt(sx, sy) {
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
  minZoom(v) {
    const reach = Math.max(v.rw / this.worldW, v.rh / this.worldH) / SPEC_ZOOM_OUT_X;
    const perf = Math.sqrt(
      v.rw * v.rh / (SPEC_MAX_VISIBLE_CELLS * this.cell * this.cell)
    );
    return Math.min(1, Math.max(reach, perf));
  }
  // Apply a zoom multiplier to a view, holding the world point under (fsx,fsy)
  // (a canvas-space pixel) fixed so zooming homes in on the cursor. While the
  // camera is still following a cycle the cam shift is harmless — updateCameras
  // re-centres next frame, so a follow-mode zoom simply scales about the target.
  zoomView(v, factor, fsx, fsy) {
    const z0 = v.zoom;
    const z1 = Math.max(this.minZoom(v), Math.min(SPEC_ZOOM_MAX, z0 * factor));
    if (z1 === z0) return;
    const wx = v.camx + (fsx - v.rx) / z0;
    const wy = v.camy + (fsy - v.ry) / z0;
    v.camx = wx - (fsx - v.rx) / z1;
    v.camy = wy - (fsy - v.ry) / z1;
    v.zoom = z1;
  }
  // Pan a view's camera by a world-pixel delta and drop it into free-look. The
  // camera coordinate is wrapped into one world span so it never drifts off into
  // huge values across a long pan (the torus makes every position equivalent).
  panView(v, dxWorld, dyWorld) {
    v.free = true;
    v.camx = ((v.camx + dxWorld) % this.worldW + this.worldW) % this.worldW;
    v.camy = ((v.camy + dyWorld) % this.worldH + this.worldH) % this.worldH;
  }
  // Mouse-wheel zoom over a viewport. `dir` > 0 zooms in, < 0 zooms out. Returns
  // true when it acted, so the caller knows whether to swallow the page scroll.
  spectateZoomAt(sx, sy, dir) {
    if (this.state !== "playing") return false;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return false;
    this.zoomView(v, dir > 0 ? SPEC_ZOOM_STEP : 1 / SPEC_ZOOM_STEP, sx, sy);
    return true;
  }
  // Pinch zoom (touch): scale the view under (sx,sy) by an arbitrary factor
  // about that point — the pinch midpoint stays put as the fingers spread/close.
  spectatePinchAt(sx, sy, factor) {
    if (this.state !== "playing") return;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return;
    this.zoomView(v, factor, sx, sy);
  }
  // Keyboard zoom for a specific downed pilot — zooms about the view centre.
  spectateZoom(pilot, dir) {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    this.zoomView(
      v,
      dir > 0 ? SPEC_ZOOM_STEP : 1 / SPEC_ZOOM_STEP,
      v.rx + v.rw / 2,
      v.ry + v.rh / 2
    );
  }
  // Mouse-drag free-look: pan the viewport under (sx,sy) by a canvas-pixel delta.
  spectatePanAt(sx, sy, dxScreen, dyScreen) {
    if (this.state !== "playing") return;
    const v = this.viewAt(sx, sy);
    if (!v || v.player.alive) return;
    this.panView(v, -dxScreen / v.zoom, -dyScreen / v.zoom);
  }
  // Keyboard free-look nudge for a specific downed pilot. dirX/dirY in {-1,0,1};
  // each press slides the camera a fixed fraction of the framed window.
  spectatePan(pilot, dirX, dirY) {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    this.panView(
      v,
      dirX * (v.rw / v.zoom) * SPEC_PAN_FRAC,
      dirY * (v.rh / v.zoom) * SPEC_PAN_FRAC
    );
  }
  // Reset a downed pilot's spectate view back to the default framing: exit
  // free-look (re-lock onto the followed cycle) and restore the normal zoom. The
  // single "snap back to the action" button, useful from any zoomed/panned state.
  spectateFollow(pilot) {
    if (pilot.alive) return;
    const v = this.views.find((vw) => vw.player === pilot);
    if (!v) return;
    v.free = false;
    v.zoom = 1;
  }
  updateCameras(dt) {
    const lerp = Math.min(1, dt / 90);
    for (const v of this.views) {
      if (v.free) continue;
      const t = this.camTarget(v);
      if (!t) continue;
      const { ox, oy } = this.headOffsetVec(t);
      const vw = v.rw / v.zoom;
      const vh = v.rh / v.zoom;
      const desiredX = this.nearestWrapPx(
        (t.x + ox + 0.5) * this.cell - vw / 2,
        v.camx,
        this.worldW
      );
      const desiredY = this.nearestWrapPx(
        (t.y + oy + 0.5) * this.cell - vh / 2,
        v.camy,
        this.worldH
      );
      v.camx += (desiredX - v.camx) * lerp;
      v.camy += (desiredY - v.camy) * lerp;
    }
  }
  // ---- rendering ---------------------------------------------------------
  render() {
    const { ctx, viewW, viewH } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, viewW, viewH);
    if (this.state === "idle" || this.views.length === 0) return;
    if (this.state === "roundover") {
      this.renderOverview();
      return;
    }
    for (const v of this.views) this.renderView(v);
    if (this.views.length > 1) {
      ctx.fillStyle = "#2a2a40";
      ctx.fillRect(this.views[0].rw, 0, this.views[1].rx - this.views[0].rw, viewH);
    }
  }
  // a single zoomed-out view of the entire world, scaled to fit the canvas
  renderOverview() {
    const { ctx, viewW, viewH, worldW, worldH } = this;
    const margin = 28;
    const scale = Math.min(
      (viewW - margin * 2) / worldW,
      (viewH - margin * 2) / worldH
    );
    const ox = (viewW - worldW * scale) / 2;
    const oy = (viewH - worldH * scale) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    if (this.bgPattern) {
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(0, 0, worldW, worldH);
    } else {
      ctx.fillStyle = "#2a2a30";
      ctx.fillRect(0, 0, worldW, worldH);
    }
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
    for (const p of this.players) {
      if (!p.alive) continue;
      this.drawHead(p);
    }
    ctx.restore();
  }
  renderView(v) {
    const { ctx, cell } = this;
    const vw = v.rw / v.zoom;
    const vh = v.rh / v.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.rx, v.ry, v.rw, v.rh);
    ctx.clip();
    ctx.save();
    ctx.translate(v.rx, v.ry);
    ctx.scale(v.zoom, v.zoom);
    ctx.translate(-v.camx, -v.camy);
    if (this.bgPattern) {
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(v.camx, v.camy, vw, vh);
    } else {
      ctx.fillStyle = "#2a2a30";
      ctx.fillRect(v.camx, v.camy, vw, vh);
    }
    const c0 = Math.floor(v.camx / cell);
    const c1 = Math.floor((v.camx + vw) / cell);
    const r0 = Math.floor(v.camy / cell);
    const r1 = Math.floor((v.camy + vh) / cell);
    for (let y = r0; y <= r1; y++) {
      for (let x = c0; x <= c1; x++) {
        const gi = this.idx(x, y);
        const val = this.grid[gi];
        if (val === WALL) this.drawWall(x, y);
        else if (val === DEATH) this.drawDeath(x, y);
        else if (val >= 0) this.drawTrail(x, y, val, gi);
        else if (this.scorch[gi]) this.drawScorch(x, y);
      }
    }
    ctx.shadowColor = "#ffcc33";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#ffe08a";
    for (const pr of this.projectiles) {
      const xs = this.visibleShifts(pr.x, v.camx, vw, this.cols);
      const ys = this.visibleShifts(pr.y, v.camy, vh, this.rows);
      for (const sx of xs) {
        for (const sy of ys) {
          const px = (pr.x + sx) * cell;
          const py = (pr.y + sy) * cell;
          ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
        }
      }
    }
    ctx.shadowBlur = 0;
    for (const p of this.players) {
      if (!p.alive) continue;
      const xs = this.visibleShifts(p.x, v.camx, vw, this.cols);
      const ys = this.visibleShifts(p.y, v.camy, vh, this.rows);
      for (const sx of xs) {
        for (const sy of ys) {
          ctx.save();
          ctx.translate(sx * cell, sy * cell);
          this.drawCycle(p);
          ctx.restore();
        }
      }
    }
    for (const e of this.explosions) {
      const xs = this.visibleShifts(e.x, v.camx, vw, this.cols);
      const ys = this.visibleShifts(e.y, v.camy, vh, this.rows);
      for (const sx of xs) {
        for (const sy of ys) {
          ctx.save();
          ctx.translate(sx * cell, sy * cell);
          this.drawExplosion(e);
          ctx.restore();
        }
      }
    }
    ctx.restore();
    this.drawOffscreenIndicators(v);
    this.drawViewHud(v);
    ctx.restore();
  }
  // Edge-of-screen markers pointing toward the nearest off-screen rivals, so you
  // can tell where threats are when the camera only frames a sliver of a big
  // arena. Drawn in canvas coords with the viewport clip still active. Capped at
  // the closest cycles so a 500-strong field can't ring the screen, and each
  // arrow's size + opacity scales with proximity so nearer threats read louder.
  drawOffscreenIndicators(v) {
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
    const vw = v.rw / v.zoom;
    const vh = v.rh / v.zoom;
    const marks = [];
    for (const p of this.players) {
      if (!p.alive || p === subject) continue;
      const wx = this.wrapNearCell(p.x, v.camx, vw, this.cols);
      const wy = this.wrapNearCell(p.y, v.camy, vh, this.rows);
      const sx = ((wx + 0.5) * cell - v.camx) * v.zoom + v.rx;
      const sy = ((wy + 0.5) * cell - v.camy) * v.zoom + v.ry;
      if (sx >= v.rx && sx <= v.rx + v.rw && sy >= v.ry && sy <= v.ry + v.rh) {
        continue;
      }
      const dx = sx - cx;
      const dy = sy - cy;
      marks.push({ sx, sy, dist: dx * dx + dy * dy, color: p.color });
    }
    if (marks.length === 0) return;
    marks.sort((a, b) => a.dist - b.dist);
    const shown = marks.slice(0, 10);
    for (let i = 0; i < shown.length; i++) {
      const m = shown[i];
      const dx = m.sx - cx;
      const dy = m.sy - cy;
      const tx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity;
      const ty = dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      const ex = Math.max(left, Math.min(right, cx + dx * t));
      const ey = Math.max(top, Math.min(bottom, cy + dy * t));
      const rank = shown.length > 1 ? 1 - i / (shown.length - 1) : 1;
      const s = (9 + 16 * rank) * 0.7;
      const alpha = 0.55 + 0.45 * rank;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(ex, ey);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.75, s * 0.8);
      ctx.lineTo(-s * 0.75, -s * 0.8);
      ctx.closePath();
      ctx.fillStyle = brighten(m.color, 0.35);
      ctx.shadowColor = m.color;
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
  drawTrail(x, y, id, base) {
    const { ctx, cell } = this;
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;
    const dirs = this.dirs;
    const grads = this.trailGrads[id];
    const px = x * cell;
    const py = y * cell;
    const dir = dirs[base];
    const gx = base % cols;
    const gy = (base - gx) / cols;
    let fwd = -1;
    for (let d = 0; d < 4; d = d + 1) {
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
    let g2;
    if (fwd !== -1 && fwd !== dir) {
      g2 = grads.d;
    } else {
      const axis = fwd !== -1 ? fwd : dir;
      g2 = axis === 0 || axis === 2 ? grads.v : grads.h;
    }
    ctx.translate(px, py);
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, cell, cell);
    ctx.translate(-px, -py);
  }
  drawWall(x, y) {
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
  drawScorch(x, y) {
    const { ctx, cell } = this;
    ctx.fillStyle = "rgba(60, 60, 66, 0.7)";
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  drawDeath(x, y) {
    const { ctx, cell } = this;
    const px = x * cell;
    const py = y * cell;
    ctx.fillStyle = "#000000";
    ctx.fillRect(px, py, cell, cell);
    ctx.fillStyle = "#1c1c24";
    ctx.fillRect(px, py, cell, 1);
    ctx.fillRect(px, py, 1, cell);
  }
  drawExplosion(e) {
    const { ctx, cell } = this;
    const t = Math.max(0, 1 - e.age / e.life);
    const px = e.x * cell;
    const py = e.y * cell;
    const size = e.size * cell;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.shadowColor = "#ffaa33";
    ctx.shadowBlur = 24;
    const inset = (1 - t) * cell;
    ctx.fillStyle = "#ff7a1a";
    ctx.fillRect(px + inset, py + inset, size - 2 * inset, size - 2 * inset);
    ctx.fillStyle = "#ffe7a0";
    ctx.fillRect(px + cell, py + cell, size - 2 * cell, size - 2 * cell);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // Draw the cycle's head as the "car": a glowing black tile marked with a
  // bright hazard X in the player's colour, as in the reference.
  // How far (0..1) the cycle has travelled toward its next cell since the last
  // grid step — drives smooth sub-cell motion while the simulation stays grid-based.
  headFrac(p) {
    return p.interval > 0 ? Math.max(0, Math.min(1, p.acc / p.interval)) : 0;
  }
  // The direction the cycle will move next: a human's next queued turn if any,
  // otherwise its current heading. (AI picks its turn at step time, so we can
  // only lead with the current heading there.)
  nextDir(p) {
    if (p.type === "human" && p.inputQueue.length > 0) return p.inputQueue[0];
    return p.dir;
  }
  // Sub-cell offset of the rendered head, in cell units, toward the next cell.
  headOffsetVec(p) {
    if (!p.alive) return { ox: 0, oy: 0 };
    const d = this.nextDir(p);
    const nx = p.x + DELTA[d].x;
    const ny = p.y + DELTA[d].y;
    if (!this.isFree(nx, ny)) return { ox: 0, oy: 0 };
    const f = this.headFrac(p);
    return { ox: DELTA[d].x * f, oy: DELTA[d].y * f };
  }
  // Draw a moving cycle: first grow the leading bit of trail into the next cell
  // so the line keeps up with the gliding car (no whole-block pop-in), then the
  // car itself at its interpolated position.
  drawCycle(p) {
    const { ctx, cell } = this;
    const d = this.nextDir(p);
    const nx = p.x + DELTA[d].x;
    const ny = p.y + DELTA[d].y;
    const lead = this.isFree(nx, ny);
    const f = lead ? this.headFrac(p) : 0;
    if (f > 0) {
      const vertical = d === 0 || d === 2;
      const g2 = vertical ? this.trailGrads[p.id].v : this.trailGrads[p.id].h;
      const ext = cell * f;
      ctx.save();
      ctx.fillStyle = g2;
      if (d === 1) {
        ctx.translate(p.x * cell, p.y * cell);
        ctx.fillRect(cell, 0, ext, cell);
      } else if (d === 3) {
        ctx.translate(nx * cell, p.y * cell);
        ctx.fillRect(cell - ext, 0, ext, cell);
      } else if (d === 2) {
        ctx.translate(p.x * cell, p.y * cell);
        ctx.fillRect(0, cell, cell, ext);
      } else {
        ctx.translate(p.x * cell, ny * cell);
        ctx.fillRect(0, cell - ext, cell, ext);
      }
      ctx.restore();
    }
    const { ox, oy } = lead ? { ox: DELTA[d].x * f, oy: DELTA[d].y * f } : { ox: 0, oy: 0 };
    this.drawHead(p, ox, oy);
  }
  drawHead(p, ox = 0, oy = 0) {
    const { ctx, cell } = this;
    const px = (p.x + ox) * cell;
    const py = (p.y + oy) * cell;
    const m = Math.max(1, Math.round(cell * 0.08));
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#0a0a10";
    ctx.fillRect(px + m, py + m, cell - 2 * m, cell - 2 * m);
    ctx.shadowBlur = 0;
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
  drawViewHud(v) {
    const { ctx } = this;
    const own = v.player;
    const subject = own.alive ? own : this.camTarget(v);
    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.textBaseline = "top";
    if (own.alive) {
      ctx.fillStyle = own.color;
      ctx.fillText(own.name, v.rx + 10, v.ry + 8);
    } else {
      ctx.fillStyle = "#777788";
      ctx.fillText(`${own.name} \u2014 DOWN`, v.rx + 10, v.ry + 8);
      const canEnd = !this.humansAlive();
      const zoomTag = v.zoom !== 1 ? `  \xB7  ${v.zoom.toFixed(1)}\xD7` : "";
      if (subject) {
        if (v.free) {
          ctx.save();
          ctx.strokeStyle = "rgba(255, 207, 106, 0.5)";
          ctx.lineWidth = 2;
          ctx.strokeRect(v.rx + 1.5, v.ry + 1.5, v.rw - 3, v.rh - 3);
          ctx.restore();
        }
        ctx.font = "bold 12px 'Courier New', monospace";
        if (v.free) {
          ctx.fillStyle = "#ffcf6a";
          ctx.fillText(`FREE LOOK${zoomTag}`, v.rx + 10, v.ry + 27);
        } else {
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
        ctx.fillText("keys:  \u25C4\u25BA cycle   \u25B2\u25BC zoom   sprint+arrows pan", v.rx + 10, v.ry + 44);
        ctx.fillText("mouse: wheel zoom   drag to pan", v.rx + 10, v.ry + 57);
        ctx.fillText("fire: reset view", v.rx + 10, v.ry + 70);
        if (canEnd) ctx.fillText("\u21B5 end round", v.rx + 10, v.ry + 83);
      } else {
        ctx.fillStyle = "#9a9aa8";
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillText("no cycles left to follow", v.rx + 10, v.ry + 27);
        if (canEnd) ctx.fillText("\u21B5 end round", v.rx + 10, v.ry + 41);
      }
    }
    if (!subject) return;
    const p = subject;
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
  makeBgPattern() {
    const cell = this.cell;
    const PANEL = 4;
    const size = cell * PANEL;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const c = off.getContext("2d");
    if (!c) return null;
    for (let ty = 0; ty < PANEL; ty++) {
      for (let tx = 0; tx < PANEL; tx++) {
        const ox = tx * cell;
        const oy = ty * cell;
        c.fillStyle = "#5a5a61";
        c.fillRect(ox, oy, cell, cell);
        c.fillStyle = "#8c8c93";
        c.fillRect(ox + 1, oy + 1, cell - 2, cell - 2);
        c.fillStyle = "#9a9aa1";
        c.fillRect(ox + 1, oy + 1, cell - 2, 1);
        c.fillRect(ox + 1, oy + 1, 1, cell - 2);
        c.fillStyle = "#76767c";
        c.fillRect(ox + 1, oy + cell - 2, cell - 2, 1);
        c.fillRect(ox + cell - 2, oy + 1, 1, cell - 2);
        c.fillStyle = "#96969d";
        c.fillRect(ox + cell / 2 - 1, oy + cell / 2 - 1, 2, 2);
      }
    }
    const t = 3;
    c.fillStyle = "#1b1b1f";
    c.fillRect(0, 0, size, t);
    c.fillRect(0, 0, t, size);
    c.fillStyle = "#6f6f76";
    c.fillRect(t, t, size - t, 1);
    c.fillRect(t, t, 1, size - t);
    return this.ctx.createPattern(off, "repeat");
  }
};

// train/headless.ts
var STUB = new Proxy(function() {
}, {
  get: (_t, p) => p === Symbol.toPrimitive ? () => 0 : STUB,
  apply: () => STUB,
  construct: () => STUB,
  set: () => true
});
function installStubs() {
  const g2 = globalThis;
  if (g2.__crashHeadlessStubs) return;
  if (!g2.document) g2.document = { createElement: () => STUB };
  g2.__crashHeadlessStubs = true;
}
function seedRandom(seed) {
  let s = seed >>> 0;
  Math.random = () => {
    s = s + 1831565813 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
installStubs();

// train/scale.ts
var STUB2 = new Proxy(function() {
}, {
  get: (_t, p) => p === Symbol.toPrimitive ? () => 0 : STUB2,
  apply: () => STUB2,
  construct: () => STUB2,
  set: () => true
});
globalThis.document ??= { createElement: () => STUB2 };
var N = Number(process.env.N ?? 500);
var SIZE = process.env.SIZE ?? "large";
var MODE = process.env.MODE ?? "classic";
var roster = { mode: "uniform", personality: process.env.CHAR ?? "hunter", counts: {}, pool: [] };
var config = {
  humans: 0,
  ai: N,
  speed: "normal",
  difficulty: "hard",
  map: process.env.MAP ?? "cross",
  size: SIZE,
  mode: MODE,
  roster
};
var cb = { onRoundOver: () => {
}, onStatus: () => {
} };
var game = new Game(STUB2, 160, 110, 4, 640, 440, cb);
var g = game;
var ownBlast = 0;
var rivalBlast = 0;
var collide = 0;
var blastVictim = /* @__PURE__ */ new Map();
var origDet = g.detonate.bind(g);
g.detonate = (cx, cy, owner) => {
  const before = game.players.map((p) => p.alive);
  origDet(cx, cy, owner);
  for (const p of game.players) if (before[p.id] && !p.alive) blastVictim.set(p.id, p.id === owner ? "own" : "rival");
};
var SEEDS = Number(process.env.SEEDS ?? 3);
var checkpoints = [10, 30, 62, 120, 250, 500];
var aliveAt = {};
for (const c of checkpoints) aliveAt[c] = 0;
var runs = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  seedRandom(seed);
  game.newMatch(config);
  console.log(`field=${game.players.length} on ${game.cols}x${game.rows} (${game.cols * game.rows / game.players.length | 0} cells/cycle)`);
  const prevAlive = game.players.map(() => true);
  const dt = game.players[0].baseInterval;
  let steps = 0;
  while (g.state === "playing" && steps < 600) {
    blastVictim.clear();
    game.update(dt);
    steps++;
    for (const p of game.players) {
      if (prevAlive[p.id] && !p.alive) {
        prevAlive[p.id] = false;
        const bv = blastVictim.get(p.id);
        if (bv === "own") ownBlast++;
        else if (bv === "rival") rivalBlast++;
        else collide++;
      }
    }
    if (checkpoints.includes(steps)) aliveAt[steps] += game.aliveCount;
  }
  for (const c of checkpoints) if (steps < c) aliveAt[c] += game.aliveCount;
  runs++;
}
console.log(`
${N} hunters, ${runs} runs \u2014 alive over time (avg):`);
for (const c of checkpoints) console.log(`  step ${String(c).padStart(3)} (~${(c * 0.08).toFixed(1)}s): ${(aliveAt[c] / runs).toFixed(0)} alive / ${N}`);
var totalDeaths = ownBlast + rivalBlast + collide;
console.log(`
death causes (${totalDeaths} total): ownBlast=${ownBlast} (${(100 * ownBlast / totalDeaths).toFixed(0)}%)  rivalBlast=${rivalBlast} (${(100 * rivalBlast / totalDeaths).toFixed(0)}%)  collide=${collide} (${(100 * collide / totalDeaths).toFixed(0)}%)`);
