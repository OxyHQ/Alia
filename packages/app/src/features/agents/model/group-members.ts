import type { AliaParticipant } from '@alia.onl/sdk';
import { readAgentCharacter } from '@alia.onl/sdk';
import type { Agent } from '@/shared/contracts/agents';
import { agentDisplayName } from './identity';
import { agentHandle } from '@/shared/routing/agent-address';

/**
 * The members of a group conversation as the chat draws them, in the order they answer.
 *
 * Read from the person's own agents; an id that is not among them (an agent the group was made
 * with that this list does not hold) is left out rather than drawn as somebody else. Fewer than
 * two left is not a group the chat can draw, and answers `undefined`.
 */
export function groupMembersOf(
  memberAgentIds: readonly string[] | undefined,
  agents: readonly Agent[] | undefined,
): readonly AliaParticipant[] | undefined {
  if (memberAgentIds === undefined || agents === undefined) return undefined;
  const members = memberAgentIds.flatMap((id): AliaParticipant[] => {
    const agent = agents.find((candidate) => candidate._id === id);
    return agent
      ? [
          {
            id,
            name: agentDisplayName(agent),
            handle: agentHandle(agent),
            character: readAgentCharacter(agent.character),
            color: agent.color ?? undefined,
          },
        ]
      : [];
  });
  return members.length >= 2 ? members : undefined;
}
