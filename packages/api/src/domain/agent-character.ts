/**
 * What an agent looks like: a Bloom avatar character.
 *
 * Stored whole in `agents.character`, chosen in the agent editor, drawn by Bloom's `AgentAvatar`
 * everywhere an agent appears (the chat, the sidebar, the catalogue, a delegation's answer).
 *
 * ## The vocabulary is Bloom's, restated, and not enforced
 *
 * `@oxy.so/bloom` is a React Native package and is not a dependency of this service, so the ids a
 * character is made of are restated below as a curated SUBSET, only to PICK a look for a new agent
 * (`agentCharacterFor`). A STORED character is never checked against them: validating against a
 * stale copy of somebody else's vocabulary is how a working look starts being refused (see
 * `domain/agent-color.ts`, which argues the same for colours). What `parseAgentCharacter` checks is
 * the SHAPE of what a client writes: only the keys a character has, each an id-like string, a
 * `#rrggbb` paint, a spacing in range. The client resolves the ids and falls back on a default look
 * for one it cannot draw.
 */

/** The flat shape Bloom's `AvatarCharacter` has, every field optional (a preset supplies the rest). */
export type AgentCharacter = {
  preset?: string;
  shape?: string;
  eyes?: string;
  eyewear?: string;
  accessory?: string;
  /** Named paint. */
  color?: string;
  /** Exact paint, `#rrggbb`; it wins over `color`. */
  bodyColor?: string;
  /** A multiplier (0.5 to 1.5) on the shape's eye separation. */
  eyeSpacing?: number;
};

const ID_KEYS = ['preset', 'shape', 'eyes', 'eyewear', 'accessory', 'color'] as const;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SPACING = { min: 0.5, max: 1.5 } as const;

/**
 * The shape of a character a client sends, or `null` for anything else. Known keys only, so a
 * misspelled field is a refusal now rather than a look that never takes effect.
 */
export function parseAgentCharacter(value: unknown): AgentCharacter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const known = new Set<string>([...ID_KEYS, 'bodyColor', 'eyeSpacing']);
  if (Object.keys(input).some((key) => !known.has(key))) return null;

  const out: AgentCharacter = {};
  for (const key of ID_KEYS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !ID.test(field)) return null;
    out[key] = field;
  }
  if (input.bodyColor !== undefined) {
    if (typeof input.bodyColor !== 'string' || !HEX.test(input.bodyColor)) return null;
    out.bodyColor = input.bodyColor.toLowerCase();
  }
  if (input.eyeSpacing !== undefined) {
    const spacing = input.eyeSpacing;
    if (typeof spacing !== 'number' || !Number.isFinite(spacing)) return null;
    if (spacing < SPACING.min || spacing > SPACING.max) return null;
    out.eyeSpacing = spacing;
  }
  // A character with nothing in it draws nothing: it needs a preset, or a shape and a paint.
  const drawable =
    out.preset !== undefined ||
    (out.shape !== undefined && (out.color !== undefined || out.bodyColor !== undefined));
  return drawable ? out : null;
}

/** The parts a new agent's look is picked from: the plain, friendly shapes, in the editor's order. */
export const PICKABLE_SHAPES = [
  'rounded_triangle',
  'capsule',
  'rounded_head_two_ears',
  'six_lobed_flower',
  'heart',
  'four_lobed_butterfly',
  'circle_two_ears',
  'twelve_scalloped_rosette',
  'rounded_cube',
  'rounded_diamond',
  'slender',
  'pocket',
  'petal',
  'star',
  'cloud',
  'shield',
  'pebble',
  'squircle',
] as const;

/** Bloom's named paints. */
export const PICKABLE_COLORS = [
  'pink',
  'orchid',
  'violet',
  'blue',
  'cyan',
  'teal',
  'lime',
  'yellow',
  'coral',
] as const;

/** A small, stable hash: the same seed always picks the same look. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A look for a new agent, picked from its seed (its handle): a shape and a paint, plain oval eyes,
 * nothing on its head. Stable, so proposing twice for the same seed proposes the same look, and the
 * person changes it in the editor.
 */
export function agentCharacterFor(seed: string): AgentCharacter {
  const h = hash(seed);
  return {
    shape: PICKABLE_SHAPES[h % PICKABLE_SHAPES.length]!,
    eyes: 'oval',
    eyewear: 'none',
    accessory: 'none',
    color: PICKABLE_COLORS[Math.floor(h / PICKABLE_SHAPES.length) % PICKABLE_COLORS.length]!,
  };
}
