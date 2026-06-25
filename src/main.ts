import "./style.css";
import { Game } from "./game";
import type {
  Dir,
  Difficulty,
  GameMode,
  MapSize,
  MatchConfig,
  Speed,
  Personality,
} from "./types";
import { PERSONALITIES } from "./types";
import { DEFAULT_MAP_ID } from "./maps";

// ---- world + viewport (grid based, camera follows the player) ------------
const COLS = 160;
const ROWS = 110;
const CELL = 15; // pixels per cell — base render scale (nearest crisp pixel to a 10% zoom-in from 14)
const VIEW_W = 960;
const VIEW_H = 640;

const canvas = document.getElementById("arena") as HTMLCanvasElement;
const menu = document.getElementById("menu") as HTMLDivElement;
const roundover = document.getElementById("roundover") as HTMLDivElement;
const resultText = document.getElementById("resultText") as HTMLHeadingElement;
const resultSub = document.getElementById("resultSub") as HTMLParagraphElement;
const scoreboard = document.getElementById("scoreboard") as HTMLTableElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
const hudStatus = document.getElementById("hudStatus") as HTMLSpanElement;
const leaderboard = document.getElementById("leaderboard") as HTMLDivElement;
const lbRows = document.getElementById("lbRows") as HTMLOListElement;
const lbAlive = document.getElementById("lbAlive") as HTMLDivElement;

// ---- menu selection state ------------------------------------------------
const selection: MatchConfig = {
  humans: 1,
  ai: 3,
  speed: "fast",
  difficulty: "cheating",
  map: DEFAULT_MAP_ID,
  size: "small",
  mode: "classic",
  roster: { mode: "uniform", personality: "balanced", counts: {}, pool: [] },
};

// When the chosen A.I. button is a "total" preset (16 / 32) the value is the
// total number of cycles on the map, so the rival count is whatever's left
// after the human pilots. `aiTotal` holds that target, or null for a literal
// rival count. We recompute selection.ai whenever humans or the preset change.
let aiTotal: number | null = null;
let aiLiteral = 3;

// When a custom roster (the MIX… menu) is active, the rival count comes from the
// roster builder instead of the A.I. RIVALS picker (which is greyed out). null
// means "no custom roster — use the picker".
let customAiCount: number | null = null;

function recomputeAi(): void {
  // a custom roster sets its own rival total (counts sum / random total)
  if (customAiCount !== null) {
    selection.ai = customAiCount;
    return;
  }
  // mega mode always fields 64 cycles; the engine fills bots up to the total,
  // so the manual rival count is only meaningful in classic mode.
  selection.ai =
    aiTotal === null ? aiLiteral : Math.max(0, aiTotal - selection.humans);
}

// The ARENA SIZE picker is ignored in the quad modes (mega / giga / tera fix the
// arena dimensions); the A.I. RIVALS picker is ignored both in quad modes and
// whenever a custom roster drives the rival total. Grey out whatever applies.
function updateModeUi(): void {
  const quad =
    selection.mode === "mega" ||
    selection.mode === "giga" ||
    selection.mode === "tera";
  const grey = (sel: string, off: boolean) =>
    document.querySelectorAll<HTMLDivElement>(sel).forEach((seg) => {
      seg.style.opacity = off ? "0.35" : "";
      seg.style.pointerEvents = off ? "none" : "";
    });
  grey('.seg[data-group="size"]', quad);
  grey('.seg[data-group="ai"]', quad || customAiCount !== null);
}
updateModeUi();

// The P1 binding depends on the human count: solo play uses Left Shift +
// Space; with two locals P1 falls back to Right Shift + "/" so the Left
// Shift / Space pair is free for P2.
const p1Controls = document.getElementById("p1Controls") as HTMLDivElement;
const p2Controls = document.getElementById("p2Controls") as HTMLDivElement;
function updateControlHints(): void {
  const solo = selection.humans === 1;
  p1Controls.innerHTML = solo
    ? "<b>P1 (CYAN)</b> &mdash; Arrows &middot; sprint: Left Shift &middot; rocket: <kbd>Space</kbd>"
    : "<b>P1 (CYAN)</b> &mdash; Arrows &middot; sprint: Right Shift &middot; rocket: <kbd>/</kbd>";
  p2Controls.style.display = solo ? "none" : "";
}
updateControlHints();

document.querySelectorAll<HTMLDivElement>(".seg").forEach((seg) => {
  const group = seg.dataset.group!;
  seg.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const value = btn.dataset.value!;

    // The MIX… character button opens the roster builder rather than picking a
    // value; it manages its own active state, so don't treat it like the others.
    if (group === "character" && value === "custom") {
      openRosterModal();
      return;
    }

    seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (group === "humans") {
      selection.humans = Number(value);
      recomputeAi();
      updateControlHints();
      updateRosterSummary();
    } else if (group === "ai") {
      const total = btn.dataset.total;
      if (total) aiTotal = Number(total);
      else {
        aiTotal = null;
        aiLiteral = Number(value);
      }
      recomputeAi();
      updateRosterSummary();
    } else if (group === "speed") selection.speed = value as Speed;
    else if (group === "difficulty") selection.difficulty = value as Difficulty;
    else if (group === "character") {
      // RANDOM → each bot rolls a random character, but the rival count still
      // comes from the A.I. RIVALS picker (customAiCount stays null). An empty
      // pool means "draw from every character" (see resolveRoster in game.ts).
      if (value === "random") {
        activeCharBtn = "random";
        customAiCount = null;
        selection.roster = {
          mode: "random",
          personality: "balanced",
          counts: {},
          pool: [],
        };
      } else {
        // a single named character → every bot drives that style, rivals from
        // the A.I. RIVALS picker (custom roster cleared)
        activeCharacter = value as Personality;
        activeCharBtn = value;
        customAiCount = null;
        selection.roster = {
          mode: "uniform",
          personality: activeCharacter,
          counts: {},
          pool: [],
        };
      }
      recomputeAi();
      updateModeUi();
      updateRosterSummary();
    } else if (group === "map") selection.map = value;
    else if (group === "size") selection.size = value as MapSize;
    else if (group === "mode") {
      selection.mode = value as GameMode;
      recomputeAi();
      updateModeUi();
      updateRosterSummary();
    }
  });
});

// ---- A.I. roster builder (the MIX… menu) ---------------------------------
// `activeCharacter` is the uniform-mode personality picked from the row.
// `activeCharBtn` is the data-value of the character-row button to re-select if
// the roster modal is cancelled — a named character or "random" (the MIX…
// custom button is handled separately on DONE).
let activeCharacter: Personality = "balanced";
let activeCharBtn = "balanced";

const rosterModal = document.getElementById("rosterModal") as HTMLDivElement;
const rosterRows = document.getElementById("rosterRows") as HTMLDivElement;
const rosterTotalEl = document.getElementById("rosterTotal") as HTMLSpanElement;
const randomPool = document.getElementById("randomPool") as HTMLDivElement;
const randomTotalEl = document.getElementById("randomTotal") as HTMLSpanElement;
const rosterSummary = document.getElementById("rosterSummary") as HTMLDivElement;
const charSeg = document.querySelector<HTMLDivElement>(
  '.seg[data-group="character"]',
)!;

// working state for the modal — committed to `selection.roster` only on DONE
const rosterState = {
  mode: "counts" as "counts" | "random",
  counts: Object.fromEntries(
    PERSONALITIES.map((p) => [p.id, 0]),
  ) as Record<Personality, number>,
  randomTotal: 6,
  pool: new Set<Personality>(PERSONALITIES.map((p) => p.id)),
};

// build the per-character stepper rows and the random-pool checkboxes once
rosterRows.innerHTML = PERSONALITIES.map(
  (p) => `
  <div class="roster-row" data-pers="${p.id}">
    <span class="roster-name" title="${p.blurb}">${p.label}</span>
    <div class="stepper">
      <button data-step="-1" aria-label="fewer">&minus;</button>
      <span class="roster-count">0</span>
      <button data-step="1" aria-label="more">+</button>
    </div>
  </div>`,
).join("");
randomPool.innerHTML = PERSONALITIES.map(
  (p) => `
  <label class="pool-item" title="${p.blurb}">
    <input type="checkbox" data-pers="${p.id}" checked /> ${p.label}
  </label>`,
).join("");

const countsTotal = (): number =>
  Object.values(rosterState.counts).reduce((s, c) => s + c, 0);

function refreshRosterModal(): void {
  // section visibility follows the method toggle
  document
    .getElementById("rosterCounts")!
    .classList.toggle("hidden", rosterState.mode !== "counts");
  document
    .getElementById("rosterRandom")!
    .classList.toggle("hidden", rosterState.mode !== "random");

  // counts: reflect each stepper value and the running total
  rosterRows.querySelectorAll<HTMLDivElement>(".roster-row").forEach((row) => {
    const id = row.dataset.pers as Personality;
    row.querySelector(".roster-count")!.textContent = String(
      rosterState.counts[id],
    );
  });
  rosterTotalEl.textContent = String(countsTotal());

  // random: reflect total and pool checkboxes
  randomTotalEl.textContent = String(rosterState.randomTotal);
  randomPool
    .querySelectorAll<HTMLInputElement>("input[data-pers]")
    .forEach((cb) => {
      cb.checked = rosterState.pool.has(cb.dataset.pers as Personality);
    });
}

function openRosterModal(): void {
  refreshRosterModal();
  rosterModal.classList.remove("hidden");
}

// METHOD toggle (PICK COUNTS / RANDOM MIX) inside the modal
document
  .querySelector<HTMLDivElement>('.seg[data-group="rosterMode"]')!
  .addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    document
      .querySelectorAll('.seg[data-group="rosterMode"] button')
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    rosterState.mode = btn.dataset.value as "counts" | "random";
    refreshRosterModal();
  });

// per-character steppers
rosterRows.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  const row = btn.closest<HTMLDivElement>(".roster-row")!;
  const id = row.dataset.pers as Personality;
  const next = rosterState.counts[id] + Number(btn.dataset.step);
  rosterState.counts[id] = Math.max(0, Math.min(64, next));
  refreshRosterModal();
});

// quick fills
document.getElementById("rosterPlusEach")!.addEventListener("click", () => {
  for (const p of PERSONALITIES) {
    rosterState.counts[p.id] = Math.min(64, rosterState.counts[p.id] + 1);
  }
  refreshRosterModal();
});
document.getElementById("rosterClear")!.addEventListener("click", () => {
  for (const p of PERSONALITIES) rosterState.counts[p.id] = 0;
  refreshRosterModal();
});

// random total stepper
document
  .getElementById("randomTotalStepper")!
  .addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const next = rosterState.randomTotal + Number(btn.dataset.step);
    rosterState.randomTotal = Math.max(1, Math.min(64, next));
    refreshRosterModal();
  });

// random pool checkboxes
randomPool.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (!cb.dataset.pers) return;
  const id = cb.dataset.pers as Personality;
  if (cb.checked) rosterState.pool.add(id);
  else rosterState.pool.delete(id);
});

document.getElementById("rosterCancel")!.addEventListener("click", () => {
  // bail without committing — re-select the previously active character button
  rosterModal.classList.add("hidden");
  charSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
  charSeg
    .querySelector(`button[data-value="${activeCharBtn}"]`)!
    .classList.add("active");
});

document.getElementById("rosterDone")!.addEventListener("click", () => {
  if (rosterState.mode === "counts") {
    customAiCount = countsTotal();
    selection.roster = {
      mode: "counts",
      personality: "balanced",
      counts: { ...rosterState.counts },
      pool: [],
    };
  } else {
    // an empty pool would draw from nothing — fall back to every character
    const pool = [...rosterState.pool];
    customAiCount = rosterState.randomTotal;
    selection.roster = {
      mode: "random",
      personality: "balanced",
      counts: {},
      pool,
    };
  }
  // mark the character row as MIX… and let the roster drive the rival count
  charSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
  document.getElementById("customRosterBtn")!.classList.add("active");
  rosterModal.classList.add("hidden");
  recomputeAi();
  updateModeUi();
  updateRosterSummary();
});

// one-line summary under the character row, describing the active roster
function updateRosterSummary(): void {
  const r = selection.roster!;
  const label = (id: Personality) =>
    PERSONALITIES.find((p) => p.id === id)!.label;
  if (r.mode === "uniform") {
    rosterSummary.textContent =
      r.personality === "balanced" ? "" : `All rivals: ${label(r.personality)}`;
  } else if (r.mode === "counts") {
    const parts = PERSONALITIES.filter((p) => (r.counts[p.id] ?? 0) > 0).map(
      (p) => `${r.counts[p.id]}× ${p.label}`,
    );
    rosterSummary.textContent = parts.length
      ? `Roster: ${parts.join(", ")}`
      : "Roster: (none)";
  } else {
    const pool = r.pool.length ? r.pool.map(label).join(", ") : "all characters";
    rosterSummary.textContent = `${selection.ai} random rivals from: ${pool}`;
  }
}
updateRosterSummary();

// ---- game instance -------------------------------------------------------
const game = new Game(canvas, COLS, ROWS, CELL, VIEW_W, VIEW_H, {
  onStatus: (text) => {
    hudStatus.textContent = text;
  },
  onRoundOver: (g) => {
    const longest = [...g.players].sort((a, b) => b.length - a.length)[0];

    // the player bailed out while bots were still racing — no winner crowned
    if (g.endedEarly) {
      const leader = [...g.players]
        .filter((p) => p.alive)
        .sort((a, b) => b.length - a.length)[0];
      resultText.textContent = "GAME OVER";
      resultSub.textContent = leader
        ? `Round ended early — ${leader.name} was leading; longest line: ${longest.name} (${longest.length})`
        : `Round ended early — longest line: ${longest.name} (${longest.length})`;
      renderScoreboard();
      roundover.classList.remove("hidden");
      hudStatus.textContent = "Round ended.";
      return;
    }

    // a human surviving is a win; a bot win or total wipeout is game over
    const won = g.winner?.type === "human";
    resultText.textContent = won ? "WINNER" : "GAME OVER";
    resultSub.textContent = won
      ? `${g.winnerName} wins — longest line: ${longest.name} (${longest.length})`
      : g.winnerName
        ? `${g.winnerName} survives — longest line: ${longest.name} (${longest.length})`
        : "All cycles down — total wipeout";
    renderScoreboard();
    roundover.classList.remove("hidden");
    hudStatus.textContent = won
      ? `${g.winnerName} wins.`
      : g.winnerName
        ? `${g.winnerName} survives.`
        : "Total wipeout.";
  },
});

// How many finishers to list before falling back to "top N + your rank". Big
// fields (mega/giga/tera) have far too many cycles to dump into one table, so
// we show the leaders plus each human's own placement — same idea as the live
// leaderboard.
const SB_TOP = 12;

function renderScoreboard(): void {
  const ranked = [...game.players].sort(
    (a, b) => b.length - a.length || b.wins - a.wins,
  );
  const rankOf = new Map(ranked.map((p, i) => [p, i + 1]));

  // small field: show everyone; large field: top finishers + any human not
  // already shown, with an ellipsis row marking the jump down to their rank.
  let rows: { p: (typeof ranked)[number]; gapBefore: boolean }[];
  if (ranked.length <= SB_TOP + 3) {
    rows = ranked.map((p) => ({ p, gapBefore: false }));
  } else {
    const top = ranked.slice(0, SB_TOP);
    const shown = new Set(top);
    const humans = ranked.filter((p) => p.type === "human" && !shown.has(p));
    rows = [
      ...top.map((p) => ({ p, gapBefore: false })),
      ...humans.map((p, i) => ({
        p,
        gapBefore: i === 0 && rankOf.get(p)! > SB_TOP + 1,
      })),
    ];
  }

  const body = rows
    .map(({ p, gapBefore }) => {
      const cls = [p.alive ? "" : "dead", p.type === "human" ? "me" : ""]
        .filter(Boolean)
        .join(" ");
      const gap = gapBefore
        ? `<tr class="gap"><td colspan="6">&middot;&middot;&middot;</td></tr>`
        : "";
      return (
        gap +
        `<tr class="${cls}">` +
        `<td class="rank">${rankOf.get(p)}</td>` +
        `<td style="color:${p.color}">&#9632; ${p.name}</td>` +
        `<td class="len">${p.length}</td>` +
        `<td class="kills">${p.kills}</td>` +
        `<td class="blocks">${p.blocksDestroyed}</td>` +
        `<td class="wins">${p.wins}</td></tr>`
      );
    })
    .join("");

  const caption =
    ranked.length > rows.length
      ? `<caption>${rows.length} of ${ranked.length} cycles shown</caption>`
      : "";
  scoreboard.innerHTML =
    caption +
    `<tr><th class="rank">#</th><th>CYCLE</th><th>LENGTH</th><th>KILLS</th><th>BLOCKS</th><th>WINS</th></tr>` +
    body;
}

// How many leaders to always show before the "you are here" rows. With a big
// grid (mega/giga) the full list won't fit, so we show the top few plus each
// human's own rank; small grids still show everyone.
const LB_TOP = 5;

function renderLeaderboard(): void {
  if (game.players.length === 0 || menuOpen()) {
    leaderboard.classList.add("hidden");
    return;
  }
  leaderboard.classList.remove("hidden");

  lbAlive.textContent = `${game.aliveCount} / ${game.players.length} ALIVE`;

  const ranked = [...game.players]
    .map((p) => p)
    .sort((a, b) => b.length - a.length);
  const rankOf = new Map(ranked.map((p, i) => [p, i + 1]));

  // small field: just show the whole ladder
  let rows: { p: (typeof ranked)[number]; gapBefore: boolean }[];
  if (ranked.length <= LB_TOP + 3) {
    rows = ranked.map((p) => ({ p, gapBefore: false }));
  } else {
    // top leaders, then any human not already shown (in rank order)
    const top = ranked.slice(0, LB_TOP);
    const shown = new Set(top);
    const me = ranked.filter((p) => p.type === "human" && !shown.has(p));
    rows = [
      ...top.map((p) => ({ p, gapBefore: false })),
      ...me.map((p, i) => ({
        p,
        // an ellipsis row marks the jump from the leaders down to the player
        gapBefore: i === 0 && rankOf.get(p)! > LB_TOP + 1,
      })),
    ];
  }

  lbRows.innerHTML = rows
    .map(({ p, gapBefore }) => {
      const cls = [p.alive ? "" : "dead", p.type === "human" ? "me" : ""]
        .filter(Boolean)
        .join(" ");
      const gap = gapBefore
        ? `<li class="gap"><span>&middot;&middot;&middot;</span></li>`
        : "";
      return (
        gap +
        `<li class="${cls}">` +
        `<span class="rank">${rankOf.get(p)}</span>` +
        `<span class="name" style="color:${p.color}">&#9632; ${p.name}</span>` +
        `<span class="kills" title="kills">${p.kills}</span>` +
        `<span class="blocks" title="blocks destroyed">${p.blocksDestroyed}</span>` +
        `<span class="len" title="length">${p.length}</span></li>`
      );
    })
    .join("");
}

const menuOpen = (): boolean => !menu.classList.contains("hidden");

// ---- input ---------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (menuOpen()) return;

  if (game.state === "roundover") {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      roundover.classList.add("hidden");
      game.startRound();
    } else if (e.code === "Escape") {
      roundover.classList.add("hidden");
      menu.classList.remove("hidden");
    }
    return;
  }

  if (e.code === "Escape") {
    menu.classList.remove("hidden");
    return;
  }

  // a downed pilot can call the round early (jump straight to the results)
  // instead of waiting for the bots to finish — only once every human is down,
  // so a survivor's round can't be cut short. Spectating stays available; this
  // is just the alternative to it.
  if (
    e.code === "Enter" &&
    game.players.some((p) => p.type === "human") &&
    !game.humansAlive()
  ) {
    e.preventDefault();
    game.endRoundEarly();
    return;
  }

  // steering + actions for human players
  for (const p of game.players) {
    if (p.type !== "human" || !p.keys) continue;
    const k = p.keys;
    let dir: Dir | null = null;
    if (e.code === k.up) dir = 0;
    else if (e.code === k.right) dir = 1;
    else if (e.code === k.down) dir = 2;
    else if (e.code === k.left) dir = 3;

    if (dir !== null) {
      e.preventDefault();
      if (p.alive) {
        game.steerHuman(p, dir);
      } else if (p.sprint) {
        // SPRINT held = free-look modifier: the arrows pan the spectate camera
        // around the arena (left/right/up/down) instead of switching/zooming
        if (dir === 3) game.spectatePan(p, -1, 0);
        else if (dir === 1) game.spectatePan(p, 1, 0);
        else if (dir === 0) game.spectatePan(p, 0, -1);
        else game.spectatePan(p, 0, 1);
      } else {
        // plain arrows when down: left/right switch the followed cycle (re-locking
        // the camera onto it), up/down zoom the spectate camera in/out
        if (dir === 3) game.spectateStep(p, -1);
        else if (dir === 1) game.spectateStep(p, 1);
        else if (dir === 0) game.spectateZoom(p, 1);
        else game.spectateZoom(p, -1);
      }
    } else if (e.code === k.sprint) {
      p.sprint = true;
    } else if (e.code === k.shoot) {
      e.preventDefault();
      // alive: fire a rocket. down: snap the camera back onto the followed cycle
      // (exits free-look) — the quick "return to the action" button.
      if (p.alive) game.tryShoot(p);
      else game.spectateFollow(p);
    }
  }
});

window.addEventListener("keyup", (e) => {
  for (const p of game.players) {
    if (p.type === "human" && p.keys && e.code === p.keys.sprint) {
      p.sprint = false;
    }
  }
});

// ---- spectator mouse controls (zoom + free-look) -------------------------
// The canvas is a fixed 960×640 buffer scaled to fit by CSS, so client pixels
// map to canvas pixels through the displayed rect. These only do anything over a
// viewport whose pilot is down (the game gates that) — live play is untouched.
function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

// wheel zooms the spectate view under the cursor; only swallow the page scroll
// when it actually acted on a downed view
canvas.addEventListener(
  "wheel",
  (e) => {
    const pt = canvasPoint(e.clientX, e.clientY);
    if (game.spectateZoomAt(pt.x, pt.y, e.deltaY < 0 ? 1 : -1)) e.preventDefault();
  },
  { passive: false },
);

// click-drag = free-look pan. The view is resolved from where the drag STARTED
// (downPt) so sliding across the split-screen seam keeps panning the same view.
let dragging = false;
let downPt = { x: 0, y: 0 };
let lastX = 0;
let lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return; // left button only
  const pt = canvasPoint(e.clientX, e.clientY);
  if (!game.canSpectateAt(pt.x, pt.y)) return; // nothing to free-look here
  dragging = true;
  downPt = pt;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  if (!dragging) {
    // hover affordance: open-hand over a viewport you can free-look, so the
    // drag-to-pan feature is discoverable without reading the HUD text
    const pt = canvasPoint(e.clientX, e.clientY);
    canvas.style.cursor = game.canSpectateAt(pt.x, pt.y) ? "grab" : "";
    return;
  }
  // a drag in progress that's no longer over a live spectate view (e.g. the
  // round just ended) — drop it so the grab cursor doesn't linger
  if (!game.canSpectateAt(downPt.x, downPt.y)) {
    endDrag(e);
    return;
  }
  // client delta -> canvas-pixel delta
  const dx = ((e.clientX - lastX) / rect.width) * canvas.width;
  const dy = ((e.clientY - lastY) / rect.height) * canvas.height;
  lastX = e.clientX;
  lastY = e.clientY;
  game.spectatePanAt(downPt.x, downPt.y, dx, dy);
});
const endDrag = (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  canvas.style.cursor = "";
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---- start ---------------------------------------------------------------
startBtn.addEventListener("click", () => {
  menu.classList.add("hidden");
  roundover.classList.add("hidden");
  game.newMatch(selection);
});

// ---- touch controls ------------------------------------------------------
// Mirror the keyboard handling above, driving the first human pilot. Only
// revealed on coarse-pointer devices; desktop play is unchanged.
const touch = document.getElementById("touch") as HTMLDivElement;
const tSprint = document.getElementById("tSprint") as HTMLButtonElement;
const tRocket = document.getElementById("tRocket") as HTMLButtonElement;
const tMenu = document.getElementById("tMenu") as HTMLButtonElement;
const againBtn = document.getElementById("againBtn") as HTMLButtonElement;
const menuBtn = document.getElementById("menuBtn") as HTMLButtonElement;

const isTouch =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
if (isTouch) document.body.classList.add("touch");

const firstHuman = () => game.players.find((p) => p.type === "human") ?? null;

// Relative turning: tap the left half of the arena to turn left, the right
// half to turn right. Steering is measured against the pilot's pending
// heading (queue tail or live dir) so two quick taps chain into a U-turn
// instead of the second being dropped. When dead, the same halves step the
// spectate camera.
touch.querySelectorAll<HTMLDivElement>("[data-turn]").forEach((zone) => {
  const delta = Number(zone.dataset.turn); // -1 = left, +1 = right
  zone.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (game.state !== "playing") return;
    const p = firstHuman();
    if (!p) return;
    if (p.alive) game.steerHuman(p, ((p.pendingDir + delta + 4) % 4) as Dir);
    else game.spectateStep(p, delta);
  });
});

// SPRINT is hold-to-go; release (or the finger sliding off) ends it
const setSprint = (on: boolean) => {
  const p = firstHuman();
  if (p) p.sprint = on;
};
tSprint.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  setSprint(true);
});
["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
  tSprint.addEventListener(ev, () => setSprint(false)),
);

// FIRE while alive; once every human is down the same button ends the round
// early (its label flips to END in the frame loop below)
tRocket.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const p = firstHuman();
  if (!p) return;
  if (p.alive) game.tryShoot(p);
  else if (!game.humansAlive()) game.endRoundEarly();
});

// open the settings menu over the running game (mirrors Escape)
tMenu.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  roundover.classList.add("hidden");
  menu.classList.remove("hidden");
});

// ---- touch spectator gestures (free-look pan + pinch zoom) ----------------
// Active only while the first human is down — the `spectating` class (toggled in
// the frame loop) hands pointer-events from the turn halves to the #touch
// container, so this one element sees every finger: one finger drags to pan,
// two pinch to zoom about their midpoint, and a near-stationary tap switches the
// followed cycle (left half = previous, right half = next). Buttons are left
// alone so FIRE/END, SPRINT and MENU keep working.
const specPointers = new Map<number, { x: number; y: number }>();
let specTapZone = 0; // -1 left half / +1 right half of the canvas where a tap began
let specMoved = false; // did the gesture travel far enough to be a drag, not a tap
let pinchPrev = 0; // previous two-finger distance (canvas px)

const specActive = (): boolean => {
  const p = firstHuman();
  return game.state === "playing" && !!p && !p.alive;
};

touch.addEventListener("pointerdown", (e) => {
  if (!specActive()) return;
  if ((e.target as HTMLElement | null)?.closest("button")) return; // a control button
  e.preventDefault();
  const pt = canvasPoint(e.clientX, e.clientY);
  specPointers.set(e.pointerId, pt);
  touch.setPointerCapture(e.pointerId);
  if (specPointers.size === 1) {
    specMoved = false;
    specTapZone = pt.x < canvas.width / 2 ? -1 : 1;
  } else if (specPointers.size === 2) {
    const [a, b] = [...specPointers.values()];
    pinchPrev = Math.hypot(a.x - b.x, a.y - b.y);
  }
});

touch.addEventListener("pointermove", (e) => {
  const prev = specPointers.get(e.pointerId);
  if (!prev) return;
  const pt = canvasPoint(e.clientX, e.clientY);
  specPointers.set(e.pointerId, pt);
  if (specPointers.size >= 2) {
    // pinch: zoom about the midpoint by the ratio of finger spread
    const [a, b] = [...specPointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchPrev > 0 && d > 0) {
      game.spectatePinchAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchPrev);
    }
    pinchPrev = d;
    specMoved = true;
    return;
  }
  const dx = pt.x - prev.x;
  const dy = pt.y - prev.y;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) specMoved = true;
  game.spectatePanAt(pt.x, pt.y, dx, dy);
});

const specUp = (e: PointerEvent) => {
  if (!specPointers.has(e.pointerId)) return;
  const wasSingle = specPointers.size === 1;
  specPointers.delete(e.pointerId);
  try {
    touch.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
  // a single touch that barely moved is a tap → step the spectate camera
  if (wasSingle && !specMoved) {
    const p = firstHuman();
    if (p) game.spectateStep(p, specTapZone);
  }
  if (specPointers.size < 2) pinchPrev = 0;
};
touch.addEventListener("pointerup", specUp);
touch.addEventListener("pointercancel", specUp);

// round-over tap buttons (mirror Space / Escape)
againBtn.addEventListener("click", () => {
  roundover.classList.add("hidden");
  game.startRound();
});
menuBtn.addEventListener("click", () => {
  roundover.classList.add("hidden");
  menu.classList.remove("hidden");
});

// ---- perf HUD (toggle with the backtick key) -----------------------------
// Shows sim cost (ms/tick), frame rate, and whether the parallel AI path is live,
// so the speedup is measurable. Hidden by default; press ` to toggle.
const perfHud = document.createElement("div");
perfHud.style.cssText =
  "position:fixed;top:6px;left:6px;z-index:9999;font:11px/1.4 monospace;" +
  "color:#0f0;background:rgba(0,0,0,.6);padding:4px 7px;border-radius:4px;" +
  "white-space:pre;pointer-events:none;display:none";
document.body.appendChild(perfHud);
let perfOn = false;
let fps = 0;
window.addEventListener("keydown", (e) => {
  if (e.code === "Backquote") {
    perfOn = !perfOn;
    perfHud.style.display = perfOn ? "block" : "none";
  }
});
function updatePerfHud(dt: number): void {
  if (!perfOn) return;
  fps += (1000 / Math.max(dt, 1) - fps) * 0.1; // smoothed
  const caps = game.parallelCaps;
  const mode = game.parallelLive
    ? `PARALLEL ×${caps.workerCount}`
    : caps.available
      ? "serial (idle/small field)"
      : `serial (${caps.reason})`;
  perfHud.textContent =
    `tick ${game.tickMs.toFixed(2)} ms   ${fps.toFixed(0)} fps\n` +
    `${mode}\n` +
    `${game.aliveCount}/${game.players.length} cycles`;
}

// ---- fast-forward (toggle with F) ----------------------------------------
// Replays the *exact same* simulation, just faster: we run N normal update
// steps per real frame (each with the genuine frame dt) and render once at the
// end. Nothing in the sim logic changes — it's literally N frames executed in
// the wall-clock of one, i.e. a 10x fast-forward of the recorded game.
const FAST_SPEED = 10;
let speedMul = 1;
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyF" && !menuOpen()) {
    speedMul = speedMul === 1 ? FAST_SPEED : 1;
  }
});

// ---- main loop -----------------------------------------------------------
// The canvas renders every frame for smooth motion, but the DOM leaderboard
// (a full sort + innerHTML reparse) and the HUD status text are comparatively
// expensive and don't need 60Hz — refresh them at ~10Hz. A view-context change
// (menu opened/closed, state transition) forces an immediate refresh so the
// leaderboard's show/hide stays responsive.
const UI_INTERVAL = 100; // ms between leaderboard/HUD refreshes
let uiAcc = UI_INTERVAL; // force a refresh on the first frame
let lastUiKey = "";
let last = performance.now();
function frame(now: number): void {
  let dt = now - last;
  last = now;
  if (dt > 100) dt = 100; // clamp after tab-switch stalls

  // each substep advances the sim exactly as one normal frame would; running
  // `speedMul` of them per real frame is a faithful Nx fast-forward
  for (let i = 0; i < speedMul; i++) game.update(dt);
  game.render();
  updatePerfHud(dt);

  uiAcc += dt;
  const uiKey = `${game.state}|${menuOpen() ? 1 : 0}|${speedMul}`;
  if (uiAcc >= UI_INTERVAL || uiKey !== lastUiKey) {
    uiAcc = 0;
    lastUiKey = uiKey;
    renderLeaderboard();
    if (game.state === "playing") {
      const fast = speedMul > 1 ? `  ⏩ ${speedMul}x` : "";
      hudStatus.textContent = `RACING — ${game.aliveCount}/${game.players.length} cycles alive${fast}`;
    }
  }

  // touch controls ride along with the live arena: shown only while racing
  // (the menu and round-over panels have their own tap targets)
  if (isTouch) {
    const show = !menuOpen() && game.state === "playing";
    touch.classList.toggle("hidden", !show);
    const p = show ? firstHuman() : null;
    if (p) tRocket.textContent = p.alive ? "FIRE" : "END";
    // down → the overlay becomes the spectator gesture surface (pan/zoom/switch)
    touch.classList.toggle("spectating", !!p && !p.alive);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
