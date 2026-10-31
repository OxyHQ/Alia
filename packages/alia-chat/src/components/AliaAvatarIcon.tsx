import { AliaAvatarProvider } from './AliaAvatarProvider';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { useAliaActivity } from '../hooks/useAliaActivity';
import { ALIA_AVATAR } from '../lib/alia-character';
import { ALIA_AVATAR_STILL } from '../lib/alia-avatar-still.generated';
import { aliaIsBusy } from './AliaAvatar';

const DEFAULT_SIZE = 20;
const STILL = { uri: ALIA_AVATAR_STILL };

/**
 * Alia as a Bloom icon: pass it as `icon` / `leadingIcon` to a Bloom `Button` and the button shows
 * her — also while the chat sheet is closed (`useAliaActivity`).
 *
 * ```tsx
 * <Button icon={AliaAvatarIcon} onPress={openAlia}>Ask Alia</Button>
 * ```
 *
 * At icon size she is her still, a picture made ahead of time (`render:avatar-still`), so a header
 * that shows her loads nothing of the 3D runtime. She goes live — the runtime loads then — while
 * she thinks or works, and plays her working turn; Bloom's `Avatar` decides that
 * (`characterIsLive`), and keeps her a still under reduced motion. The still stays under her
 * until the first live frame.
 *
 * It inherits the chat's explicit runtime URL; outside a chat it uses the SDK default
 * (the companion's immutable revision on native). The
 * colour (`fill`) is ignored — the likeness is painted — and it is never interactive, so the
 * button keeps the press.
 */
export const AliaAvatarIcon: BloomIconComponent = ({ width, height }) => {
  const state = useAliaActivity();
  return (
    <AliaAvatarProvider>
      <Avatar
        character={ALIA_AVATAR}
        characterStill={STILL}
        size={width ?? height ?? DEFAULT_SIZE}
        activity={aliaIsBusy(state) ? 'working' : 'idle'}
        alt="Alia"
      />
    </AliaAvatarProvider>
  );
};
