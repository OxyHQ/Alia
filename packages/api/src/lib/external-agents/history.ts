import { EXTERNAL_HISTORY_TURNS, type ChatTurn } from '../../domain/external-agent.js';
import { textOf } from '../chat/room/transcript.js';

/** The conversation before the last user message, as the daemon wants it (oldest first). */
export function externalHistoryOf(messages: readonly { role: string; content?: unknown }[]): {
  task: string;
  history: ChatTurn[];
} {
  const turns = messages.flatMap((m): ChatTurn[] => {
    const content = textOf(m.content);
    return (m.role === 'user' || m.role === 'assistant') && content !== ''
      ? [{ role: m.role, content }]
      : [];
  });
  const lastUser = turns.map((m) => m.role).lastIndexOf('user');
  if (lastUser < 0) return { task: 'Continue', history: [] };
  return {
    task: turns[lastUser].content,
    history: turns.slice(Math.max(0, lastUser - EXTERNAL_HISTORY_TURNS), lastUser),
  };
}
