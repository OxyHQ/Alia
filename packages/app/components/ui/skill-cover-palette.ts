// Pure palette + grid helpers for SkillCover. No skia / no native imports so
// both the skia canvas and its web static fallback can share this logic.

// ─── Constants ───────────────────────────────────────────────────────────────

export const GRID_SIZE = 6;

const PULSE_SPEED = 0.002;
const PULSE_AMPLITUDE = 22;

const BREATHE_SPEED = 0.001;
const BREATHE_AMPLITUDE = 10;

const WAVE_SPEED = 0.0015;
const WAVE_AMPLITUDE = 15;
const WAVE_LENGTH = 3;

const SPARKLE_SPEED = 0.004;
const SPARKLE_THRESHOLD = 0.92;
const SPARKLE_BOOST = 25;

const HUE_SPREAD = 45;

// ─── Types ───────────────────────────────────────────────────────────────────

export type HSL = [hue: number, saturation: number, lightness: number];

export interface Cell {
  row: number;
  col: number;
  colorIndex: number;
  phase: number;
  brightness: number;
  sparklePhase: number;
}

// ─── Utility functions ───────────────────────────────────────────────────────

export function hashSeed(str: string): number {
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

export function createRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return [h * 360, s * 100, l * 100];
}

export function generatePalette(hash: number, color?: string): [HSL, HSL, HSL] {
  const rng = createRng(hash);

  // If a color hex is provided, derive palette from it
  if (color && color.startsWith("#") && color.length >= 7) {
    const [baseHue, baseSat] = hexToHsl(color);
    const sat = Math.max(60, baseSat);
    return [
      [baseHue, sat, 55 + rng() * 10],
      [
        (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
        sat - 5 + rng() * 10,
        40 + rng() * 15,
      ],
      [
        (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
        sat - 10 + rng() * 15,
        60 + rng() * 15,
      ],
    ];
  }

  const baseHue = rng() * 360;
  const sat = 75 + rng() * 20;
  return [
    [baseHue, sat, 55 + rng() * 10],
    [
      (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
      sat - 5 + rng() * 10,
      40 + rng() * 15,
    ],
    [
      (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
      sat - 10 + rng() * 15,
      60 + rng() * 15,
    ],
  ];
}

export function generateGrid(hash: number, rows: number, cols: number): Cell[] {
  const rng = createRng(hash + 1);
  const cells: Cell[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      cells.push({
        row: y,
        col: x,
        colorIndex: Math.floor(rng() * 3),
        phase: rng() * Math.PI * 2,
        brightness: 0.3 + rng() * 0.7,
        sparklePhase: rng() * Math.PI * 2,
      });
    }
  }

  return cells;
}

export function computeCellColor(
  time: number,
  cell: Cell,
  palette: [HSL, HSL, HSL],
  lightMode = false,
): string {
  "worklet";
  const [h, s, l] = palette[cell.colorIndex];

  const pulse =
    Math.sin(time * PULSE_SPEED + cell.phase) * PULSE_AMPLITUDE;
  const breatheOffset =
    Math.sin(time * BREATHE_SPEED) * BREATHE_AMPLITUDE;
  const waveDist = (cell.col + cell.row) / WAVE_LENGTH;
  const wave = Math.sin(time * WAVE_SPEED + waveDist) * WAVE_AMPLITUDE;
  const sparkleVal =
    Math.sin(time * SPARKLE_SPEED + cell.sparklePhase);
  const sparkle =
    sparkleVal > SPARKLE_THRESHOLD
      ? ((sparkleVal - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD)) *
        SPARKLE_BOOST
      : 0;

  // Light mode: boost lightness, soften saturation
  const baseLightness = lightMode ? l + 20 : l;
  const finalLight = Math.min(
    lightMode ? 95 : 90,
    Math.max(lightMode ? 50 : 20, (baseLightness + pulse + breatheOffset + wave + sparkle) * cell.brightness),
  );
  const finalSat = Math.min(100, lightMode ? s - 10 : s + 5);

  const sl = finalSat / 100;
  const ll = finalLight / 100;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return ll - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));

  const hex = (v: number) => {
    const h = v.toString(16);
    return h.length < 2 ? "0" + h : h;
  };
  return "#" + hex(r) + hex(g) + hex(b);
}

// ─── Canvas props (shared by the skia impl and its web fallback) ─────────────

export interface SkillCoverCanvasProps {
  width: number;
  height: number;
  cellW: number;
  cellH: number;
  halfW: number;
  halfH: number;
  grid: Cell[];
  palette: [HSL, HSL, HSL];
  staticColors: string[];
  glowColor: string;
  animated: boolean;
  lightMode: boolean;
  isDarkColorScheme: boolean;
}
