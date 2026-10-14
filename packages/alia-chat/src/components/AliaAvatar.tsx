import { AgentAvatar, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { useEffect, useState } from 'react';

/** What Alia is doing; the avatar plays a working turn each time it starts to think or work. */
export type AliaAvatarState = 'idle' | 'thinking' | 'working' | 'writing';

/**
 * Alia's likeness in Bloom's 3D character engine: the six-lobed flower in orchid, plain oval
 * eyes, nothing on its head. It is `blue_beret` with the hat taken off and the paint changed,
 * so Bloom retargets that preset's animation onto it; change it here and nowhere else.
 */
export const ALIA_AVATAR: AvatarCharacter = {
  preset: 'blue_beret',
  accessory: 'none',
  color: 'orchid',
};

const BUSY: ReadonlySet<AliaAvatarState> = new Set(['thinking', 'working']);

export interface AliaAvatarProps {
  /** Width and height in px. */
  size: number;
  /** What Alia is doing. Default `idle`. */
  state?: AliaAvatarState;
  /** Follows the pointer and reacts to touch, as Bloom's engine does. Default `false`. */
  interactive?: boolean;
  /** Change it to replay the avatar's reaction (a wave) — for a button that wraps it. */
  reactionKey?: number;
}

/**
 * Bloom's `AgentAvatar` dressed as Alia. It draws through the 3D runtime, so the host
 * app must mount `AgentAvatarProvider` with the URL of the hosted `character-runtime`;
 * without it Bloom shows its own "unavailable" state.
 */
export function AliaAvatar({
  size,
  state = 'idle',
  interactive = false,
  reactionKey,
}: AliaAvatarProps) {
  const [workingKey, setWorkingKey] = useState(0);
  const busy = BUSY.has(state);
  useEffect(() => {
    if (busy) setWorkingKey((key) => key + 1);
  }, [busy]);

  return (
    <AgentAvatar
      character={ALIA_AVATAR}
      size={size}
      label="Alia"
      workingKey={workingKey}
      interactive={interactive}
      reactionKey={reactionKey}
    />
  );
}
