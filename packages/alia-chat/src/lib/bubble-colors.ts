/**
 * The colours of the chat bubbles in an agent's thread.
 *
 * The person's own bubble takes the agent's colour, mixed a quarter of the way toward black so it
 * sits calmly under white text (`color-mix(in srgb, <agent> 76%, black)`), and its text is white or
 * near-black, whichever reads better on it, because an agent can be any colour, a yellow one
 * included.
 */
export interface BubbleColors {
  /** The person's bubble. */
  readonly background: string;
  /** The text on it. */
  readonly foreground: string;
}

const WHITE = '#ffffff';
const INK = '#14110f';
/** How much of the agent's colour is kept; the rest is black. */
const KEEP = 0.76;

function channels(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The bubble colours for an agent's `#rrggbb` colour; `null` for anything that is not one. */
export function bubbleColors(agentHex: string): BubbleColors | null {
  const rgb = channels(agentHex);
  if (rgb === null) return null;
  const mixed = rgb.map((c) => Math.round(c * KEEP)) as [number, number, number];
  const background = `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  // White unless it falls under the 3:1 of large text (a yellow agent); Grok's own green, at about
  // 3.7:1, keeps its white.
  const onWhite = contrast(1, luminance(mixed));
  return { background, foreground: onWhite >= 3 ? WHITE : INK };
}
