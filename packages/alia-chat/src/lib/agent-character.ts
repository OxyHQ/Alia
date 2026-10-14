import { parseAvatarCharacter, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/**
 * The look of an agent whose own is not known: a server that does not send one yet, an agent that
 * has since been deleted, a stored character this Bloom cannot draw. One neutral character, the same
 * everywhere, so an unknown look is recognisably "not chosen" and never one that belongs to somebody.
 */
export const DEFAULT_AGENT_CHARACTER: AvatarCharacter = {
  shape: 'rounded_cube',
  eyes: 'oval',
  eyewear: 'none',
  accessory: 'none',
  color: 'violet',
};

/**
 * The character an agent is drawn as, from the JSON the server stores for it
 * (`agents.character`): Bloom's own parser decides what it can draw, and anything else is the
 * default look rather than an avatar that fails to render.
 */
export function readAgentCharacter(value: unknown): AvatarCharacter {
  if (value === null || value === undefined) return DEFAULT_AGENT_CHARACTER;
  try {
    return parseAvatarCharacter(value);
  } catch {
    return DEFAULT_AGENT_CHARACTER;
  }
}
