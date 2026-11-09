import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { useAliaActivity } from '../hooks/useAliaActivity';
import { ALIA_AVATAR } from '../lib/alia-character';
import { aliaIsBusy } from './AliaAvatar';

const DEFAULT_SIZE = 20;

/**
 * Alia as a Bloom icon: pass it as `icon` / `leadingIcon` to a Bloom `Button` and the button shows
 * her — also while the chat sheet is closed (`useAliaActivity`).
 *
 * ```tsx
 * <Button icon={AliaAvatarIcon} onPress={openAlia}>Ask Alia</Button>
 * ```
 *
 * She is drawn by Bloom's SVG renderer: nothing is fetched to show her, at icon size or any other.
 * She plays her working turn while she thinks or works; Bloom's `Avatar` decides that, and keeps
 * her still under reduced motion. The colour (`fill`) is ignored — the likeness is painted — and it is never interactive, so the
 * button keeps the press.
 */
export const AliaAvatarIcon: BloomIconComponent = ({ width, height }) => {
  const state = useAliaActivity();
  return (
    <AgentAvatarProvider>
      <Avatar
        character={ALIA_AVATAR}
        size={width ?? height ?? DEFAULT_SIZE}
        activity={aliaIsBusy(state) ? 'working' : 'idle'}
        alt="Alia"
      />
    </AgentAvatarProvider>
  );
};
