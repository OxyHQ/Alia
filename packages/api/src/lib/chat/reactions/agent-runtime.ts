/** Bind the local conversation capability to an admitted hosted actor and authoritative rows. */
import { getDb } from '../../../db/index.js';
import { findAgentById } from '../../../db/agents/agentRepository.js';
import {
  listAgentReactionTargets,
  markAgentReactionTurnComplete,
  mutateAgentMessageReaction,
  type ReactionUserSnapshot,
} from '../../../db/chat/reactionRepository.js';
import { agentOpensOn } from '../../agent-availability.js';
import { agentPromptName, type HydratedAgent } from '../../agent-identity.js';
import { publishConversationReaction } from './bus.js';
import { createAgentReactionTurn } from './agent-tool.js';

export async function prepareAgentReactionTurn(input: {
  userId: string;
  conversationId: string;
  agent: HydratedAgent;
  turnId: string;
  expectedLatestUserMessage: ReactionUserSnapshot;
  surfaceApplicationId: string | null;
  /** The reachable roster authorized at admission; a direct turn contains only its own actor. */
  allowedActorIds: readonly string[];
  signal?: AbortSignal;
}) {
  const db = getDb();
  const targets = await listAgentReactionTargets(db, input.userId, input.conversationId);
  const scope = {
    userId: input.userId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    actor: { id: input.agent._id, name: agentPromptName(input.agent) },
    targets,
    signal: input.signal,
  };
  const reachable = async (actorId: string) => {
    if (!input.allowedActorIds.includes(actorId)) return false;
    const agent = await findAgentById(db, actorId);
    return (
      agent !== null &&
      (await agentOpensOn(agent.oxyAccountId, input.surfaceApplicationId)) === 'reachable'
    );
  };
  return createAgentReactionTurn(scope, {
    mutate: async ({ target, emoji, active, mutationId }) => {
      input.signal?.throwIfAborted();
      if (!(await reachable(input.agent._id))) return undefined;
      return mutateAgentMessageReaction(db, input.userId, input.conversationId, target.id, {
        actor: scope.actor,
        turnId: input.turnId,
        mutationId,
        emoji,
        active,
        expectedLatestUserMessage: input.expectedLatestUserMessage,
        expectedTarget: { content: target.content, role: target.role, actorId: target.agentInfoId },
      });
    },
    publish: (snapshot) =>
      publishConversationReaction(input.userId, {
        ...snapshot,
        conversationId: input.conversationId,
      }),
    complete: async () =>
      (await reachable(input.agent._id)) &&
      markAgentReactionTurnComplete(
        db,
        input.userId,
        input.conversationId,
        input.agent._id,
        input.turnId,
        input.expectedLatestUserMessage,
      ),
  });
}
