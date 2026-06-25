// Arena maps: structured, symmetrical interior obstacle layouts.
//
// Every layout is authored in one quadrant and mirrored across both centre
// axes (mirror4), so the result is always 4-fold symmetric — no player ever
// gets a positional advantage. All obstacles are kept inside a central region
// (well within the spawn ring at ~0.36 * min(cols,rows)) so spawns and the
// path immediately ahead of each cycle stay clear.

export type Rect = [x: number, y: number, w: number, h: number];

export interface ArenaMap {
  id: string;
  name: string;
  build: (cols: number, rows: number) => Rect[];
}

// Mirror each rect across the vertical and horizontal centre axes.
function mirror4(cols: number, rows: number, rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const [x, y, w, h] of rects) {
    out.push([x, y, w, h]);
    out.push([cols - x - w, y, w, h]);
    out.push([x, rows - y - h, w, h]);
    out.push([cols - x - w, rows - y - h, w, h]);
  }
  return out;
}

export const MAPS: ArenaMap[] = [
  {
    // A central cross with an open square at its heart.
    id: "cross",
    name: "CROSS",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 2, cy - 26, 4, 18], // upper arm of the vertical bar
        [cx - 26, cy - 2, 18, 4], // left arm of the horizontal bar
      ]);
    },
  },
  {
    // Four solid blocks around a small central pillar.
    id: "boxes",
    name: "BOXES",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 22, cy - 18, 9, 9], // one quadrant block (mirrored to all four)
        [cx - 3, cy - 3, 6, 6], // centre pillar
      ]);
    },
  },
  {
    // A rectangular frame with a gap centred on each side.
    id: "ring",
    name: "RING",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      return mirror4(cols, rows, [
        [cx - 25, cy - 22, 18, 3], // top segment of one corner
        [cx - 25, cy - 22, 3, 18], // left segment of one corner
      ]);
    },
  },
  {
    // A stepped diamond outline around a centre dot.
    id: "diamond",
    name: "DIAMOND",
    build: (cols, rows) => {
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      const rects: Rect[] = [[cx - 2, cy - 2, 4, 4]]; // centre dot
      for (let k = 0; k <= 6; k++) {
        rects.push([cx - 2 - 4 * k, cy - 26 + 4 * k, 4, 4]); // one edge of the diamond
      }
      return mirror4(cols, rows, rects);
    },
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
      // outward reach of the obstacle band, comfortably inside the spawn ring
      const R = Math.floor(Math.min(cols, rows) * 0.26);
      const gap = 3; // open corridor kept along each centre axis
      const rects: Rect[] = [];
      const count = 3 + Math.floor(Math.random() * 4); // 3..6 per quadrant
      for (let i = 0; i < count; i++) {
        const w = 3 + Math.floor(Math.random() * 8); // 3..10
        const h = 3 + Math.floor(Math.random() * 8);
        // top-left corner so the block sits between the centre gap and R,
        // with its right/bottom edge never crossing the centre corridor
        const x = cx - gap - w - Math.floor(Math.random() * (R - w + 1));
        const y = cy - gap - h - Math.floor(Math.random() * (R - h + 1));
        rects.push([x, y, w, h]);
      }
      return mirror4(cols, rows, rects);
    },
  },
];

export const DEFAULT_MAP_ID = MAPS[0].id;
