// Small hex-colour helpers shared across the game.

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function to2(c: number): string {
  return Math.max(0, Math.min(255, Math.round(c)))
    .toString(16)
    .padStart(2, "0");
}

// mix `hex` toward `target` by amt (0..1)
export function mix(hex: string, target: string, amt: number): string {
  const [r, g, b] = parse(hex);
  const [tr, tg, tb] = parse(target);
  return `#${to2(r + (tr - r) * amt)}${to2(g + (tg - g) * amt)}${to2(
    b + (tb - b) * amt,
  )}`;
}

export const brighten = (hex: string, amt: number): string =>
  mix(hex, "#ffffff", amt);

export const darken = (hex: string, amt: number): string =>
  mix(hex, "#000000", amt);

// h in [0,360), s/l in [0,1] -> "#rrggbb"
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${to2((r + m) * 255)}${to2((g + m) * 255)}${to2((b + m) * 255)}`;
}
