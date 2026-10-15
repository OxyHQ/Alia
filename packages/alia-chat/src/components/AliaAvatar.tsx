import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { memo, useEffect, useState } from 'react';
import { ALIA_AVATAR } from '../lib/alia-character';

export { ALIA_AVATAR };

/** What Alia is doing; the avatar plays a working turn each time it starts to think or work. */
export type AliaAvatarState = 'idle' | 'thinking' | 'working' | 'writing';

const BUSY: ReadonlySet<AliaAvatarState> = new Set(['thinking', 'working']);

/** Whether a state is work her avatar shows: thinking or working, not writing. */
export const aliaIsBusy = (state: AliaAvatarState): boolean => BUSY.has(state);

export interface AliaAvatarProps {
  /** Width and height in px. */
  size: number;
  /** What Alia is doing. Default `idle`. */
  state?: AliaAvatarState;
  /** Follows the pointer and reacts to touch, as Bloom's engine does. Default `false`. */
  interactive?: boolean;
  /** Change it to replay the avatar's reaction (a wave) — for a button that wraps it. */
  reactionKey?: number;
  /** A still thumbnail instead of a live 3D avatar: for small, permanent spots like a sidebar. */
  portrait?: boolean;
}

/**
 * Bloom's `AgentAvatar` dressed as Alia. It draws through the 3D runtime, so the host
 * app must mount `AgentAvatarProvider` with the URL of the hosted `character-runtime`;
 * without it Bloom shows its own "unavailable" state.
 */
export const AliaAvatar = memo(function AliaAvatar({
  size,
  state = 'idle',
  interactive = false,
  reactionKey,
  portrait = false,
}: AliaAvatarProps) {
  const [workingKey, setWorkingKey] = useState(0);
  const busy = aliaIsBusy(state);
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
      portrait={portrait}
    />
  );
});
