import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { useAliaActivity } from '../hooks/useAliaActivity';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';
import { AliaAvatar } from './AliaAvatar';

const DEFAULT_SIZE = 20;

/**
 * Alia's live avatar as a Bloom icon: pass it as `icon` / `leadingIcon` to a Bloom `Button` and
 * the button shows her, reacting as she thinks, works and writes (`useAliaActivity`) — also while
 * the chat sheet is closed.
 *
 * ```tsx
 * <Button icon={AliaAvatarIcon} onPress={openAlia}>Ask Alia</Button>
 * ```
 *
 * It mounts its own `AgentAvatarProvider` on `ALIA_CHARACTER_RUNTIME_URL`: an avatar outside the
 * chat's provider would ask the host for `/bloom-character/runtime.mjs` and get its HTML. The
 * colour (`fill`) is ignored — the likeness is painted — and it is never interactive, so the
 * button keeps the press. Reduced motion is Bloom's engine's to honour.
 */
export const AliaAvatarIcon: BloomIconComponent = ({ width, height }) => {
  const state = useAliaActivity();
  return (
    <AgentAvatarProvider runtimeUrl={ALIA_CHARACTER_RUNTIME_URL}>
      <AliaAvatar size={width ?? height ?? DEFAULT_SIZE} state={state} />
    </AgentAvatarProvider>
  );
};
