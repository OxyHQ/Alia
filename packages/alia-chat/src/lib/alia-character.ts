import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/**
 * Alia's likeness in Bloom's character renderer: the six-lobed flower in orchid, plain oval
 * eyes, nothing on its head. It is `blue_beret` with the hat taken off and the paint changed,
 * so Bloom retargets that preset's animation onto it; change it here and nowhere else.
 *
 * A module of its own, without React.
 */
export const ALIA_AVATAR: AvatarCharacter = {
  preset: 'blue_beret',
  accessory: 'none',
  color: 'orchid',
};
