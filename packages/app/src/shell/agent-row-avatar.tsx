import { AgentAvatar, type AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { create } from 'zustand';

/**
 * A reaction per agent row: the number of times its row was pressed. A row's avatar replays the
 * character's reaction when its count changes (`AgentAvatar reactionKey`), so pressing anywhere on
 * the row, not only on the picture, makes the agent react before the thread opens.
 *
 * A store of its own, not state of the sidebar: the sidebar's rows are built once per list, and a
 * press must move one avatar without rebuilding them all.
 */
const useRowReactions = create<{ counts: Record<string, number> }>(() => ({ counts: {} }));

/** Make the agent in this row react. */
export const reactAgentRow = (agentId: string) =>
  useRowReactions.setState(({ counts }) => ({
    counts: { ...counts, [agentId]: (counts[agentId] ?? 0) + 1 },
  }));

/** An agent's picture in the sidebar: alive (it idles and follows the pointer) and reacting to its row. */
export function AgentRowAvatar({
  agentId,
  character,
  size,
}: {
  agentId: string;
  character: AvatarCharacter;
  size: number;
}) {
  const reactionKey = useRowReactions((state) => state.counts[agentId]);
  return <AgentAvatar character={character} size={size} interactive reactionKey={reactionKey} />;
}
