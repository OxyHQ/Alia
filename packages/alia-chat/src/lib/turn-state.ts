import type { ChatMessage } from '../types';
import type { AliaAvatarState } from '../components/AliaAvatar';

/** What a chat turn is doing, from its messages: the one reading the header mark and every button share. */
export function turnActivityState(
  messages: ReadonlyArray<ChatMessage>,
  isStreaming: boolean,
): AliaAvatarState {
  if (!isStreaming) return 'idle';
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.toolInvocations?.some((t) => t.state === 'call'))
    return 'working';
  if (last?.thinking) return 'thinking';
  return 'writing';
}
