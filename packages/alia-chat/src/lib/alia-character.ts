import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/**
 * Alia's likeness in Bloom's 3D character engine: the six-lobed flower in orchid, plain oval
 * eyes, nothing on its head. It is `blue_beret` with the hat taken off and the paint changed,
 * so Bloom retargets that preset's animation onto it; change it here and nowhere else — and run
 * `bun run render:avatar-still` after, so her still (`alia-avatar-still.generated.ts`) matches.
 *
 * A module of its own, without React: the still's renderer script reads it under plain bun.
 */
export const ALIA_AVATAR: AvatarCharacter = {
  preset: 'blue_beret',
  accessory: 'none',
  color: 'orchid',
};
