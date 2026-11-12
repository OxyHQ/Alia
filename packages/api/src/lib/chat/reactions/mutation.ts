/** Reaction admission preserves the person's feedback independently of whether an actor can reply. */
import { getDb } from '../../../db/index.js';
import {
  findReactionTarget,
  mutateMessageReaction,
  type ReactionMutation,
} from '../../../db/chat/reactionRepository.js';
import { findConversation } from '../../../db/chat/conversationRepository.js';
import { listGroupMembers } from '../../../db/chat/conversationMemberRepository.js';
import { findAgentById } from '../../../db/agents/agentRepository.js';
import { canReachAgent } from '../../agent-account.js';
import { isExternalAgent } from '../../external-agents/turn.js';
import { log } from '../../logger.js';

export async function applyConversationReaction(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  accessToken: string | undefined;
  surfaceApplicationId: string | null;
  mutation: Pick<ReactionMutation, 'emoji' | 'active' | 'mutationId'>;
}) {
  const db = getDb();
  const target = await findReactionTarget(db, input.userId, input.conversationId, input.messageId);
  if (!target) return undefined;
  let authorizedActorId: string | undefined;
  if (input.mutation.active !== false && target.role === 'assistant' && target.targetActorId) {
    const [conversation, members, agent] = await Promise.all([
      findConversation(db, input.userId, input.conversationId),
      listGroupMembers(db, input.userId, input.conversationId),
      findAgentById(db, target.targetActorId),
    ]);
    if (agent && (conversation?.agentId === agent.id || members.includes(agent.id))) {
      try {
        const reach = await canReachAgent(agent, {
          oxyUserId: input.userId,
          accessToken: input.accessToken,
          surfaceApplicationId: input.surfaceApplicationId,
        });
        if (reach === 'reachable' && !(await isExternalAgent(agent.id)))
          authorizedActorId = agent.id;
      } catch {
        log.agents.warn(
          { agentId: agent.id },
          'Reaction response unavailable; preserving feedback',
        );
      }
    }
  }
  return mutateMessageReaction(db, input.userId, input.conversationId, input.messageId, {
    ...input.mutation,
    authorizedActorId,
    surfaceApplicationId: input.surfaceApplicationId,
  });
}
