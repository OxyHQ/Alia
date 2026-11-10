/**
 * Spaces (ADR 0028): the rules about their shape. A leaf module, importing nothing.
 */

/** A space's name, as the sidebar draws it. */
export const SPACE_NAME_MAX = 60;
/** The brief every member of a space works from. */
export const SPACE_INSTRUCTIONS_MAX = 4000;
/**
 * Agents one space holds: the group room's bound (`GROUP_MAX_MEMBERS`), because the space's room is a
 * group conversation and each person message is answered by every member. Kept as its own constant so
 * the two can be told apart if the room's bound ever moves.
 */
export const MAX_SPACE_MEMBERS = 6;

export type SpaceInput =
  | { readonly ok: true; readonly name: string; readonly instructions: string }
  | { readonly ok: false; readonly error: string };

/** A name: non-empty after trimming, within {@link SPACE_NAME_MAX}. */
export function parseSpaceName(
  value: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'name must be a non-empty string' };
  }
  const name = value.trim();
  if (name.length > SPACE_NAME_MAX) {
    return { ok: false, error: `name must be at most ${SPACE_NAME_MAX} characters` };
  }
  return { ok: true, name };
}

/** A brief: a string within {@link SPACE_INSTRUCTIONS_MAX}; absent means empty. */
export function parseSpaceInstructions(
  value: unknown,
): { ok: true; instructions: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, instructions: '' };
  if (typeof value !== 'string') return { ok: false, error: 'instructions must be a string' };
  if (value.length > SPACE_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      error: `instructions must be at most ${SPACE_INSTRUCTIONS_MAX} characters`,
    };
  }
  return { ok: true, instructions: value.trim() };
}
