import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/** FNV-1a: a stable 32-bit hash, so an agent keeps its look across sessions and devices. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The 3D character an agent appears as. An agent's account carries no avatar, so its body and
 * paint come from its id: the same agent is the same character everywhere, and two agents in a
 * conversation are told apart at a glance. Plain oval eyes, nothing on the head.
 */
export function agentCharacter(agentId: string): AvatarCharacter {
  const h = hash(agentId);
  return {
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    eyes: 'oval',
    eyewear: 'none',
    accessory: 'none',
    color: AVATAR_COLORS[Math.floor(h / AVATAR_SHAPES.length) % AVATAR_COLORS.length],
  };
}
