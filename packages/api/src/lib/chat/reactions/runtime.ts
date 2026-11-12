/** Bind durable reaction observations to the same actor, transcript, lock and message writer. */
import { getDb } from '../../../db/index.js';
import { findConversation } from '../../../db/chat/conversationRepository.js';
import { listGroupMembers } from '../../../db/chat/conversationMemberRepository.js';
import {
  isReactionEventCurrent,
  renewReactionEventLease,
  saveReactionEventDecision,
  withCurrentReaction,
  type ReactionEvent,
} from '../../../db/chat/reactionRepository.js';
import { agentOpensOn } from '../../agent-availability.js';
import { isExternalAgent } from '../../external-agents/turn.js';
import { conversationIsActive } from '../activity.js';
import { roomRuntime, appendRoomReply } from '../room/runtime.js';
import { listMessages } from '../../../db/chat/messageRepository.js';
import { findSpaceByConversation } from '../../../db/spaces/spaceRepository.js';
import { textOf } from '../room/transcript.js';
import { processReactionEvent } from './engine.js';
import { getRedisClient } from '../../redis.js';

export async function runReactionEvent(event: ReactionEvent, leaseValid: () => boolean) {
  // A multi-instance production worker must never substitute a process-local room lock.
  if (process.env.NODE_ENV === 'production' && !getRedisClient())
    throw new Error('Room lock unavailable');
  const room = roomRuntime().deps;
  let owned = true;
  const owns = async () => {
    owned =
      owned &&
      leaseValid() &&
      event.leaseToken !== null &&
      (await renewReactionEventLease(getDb(), event.id, event.leaseToken));
    return owned;
  };
  const current = async () => (await owns()) && (await isReactionEventCurrent(getDb(), event));
  return processReactionEvent(event, {
    room: {
      ...room,
      publish: (event) => (owned && leaseValid() ? room.publish(event) : Promise.resolve()),
      loadTranscript: async (userId, conversationId) => {
        const [rows, conversation] = await Promise.all([
          room.loadTranscript(userId, conversationId),
          findConversation(getDb(), userId, conversationId),
        ]);
        return rows.map((row) => ({
          ...row,
          agentId: row.agentId ?? (row.role === 'assistant' ? conversation?.agentId : null),
        }));
      },
    },
    current,
    owns,
    space: async () => {
      const space = await findSpaceByConversation(getDb(), event.userId, event.conversationId);
      return space ? { name: space.name, instructions: space.instructions } : null;
    },
    commit: async (_, input) => {
      if (!event.leaseToken || !owned || !leaseValid()) return null;
      return withCurrentReaction(
        getDb(),
        event,
        event.leaseToken,
        async (tx) => ({ ...(await appendRoomReply(tx, input)), content: input.content }),
        async (tx) => {
          const row = (await listMessages(tx, event.userId, event.conversationId)).find(
            (row) => row.clientMessageId === input.clientMessageId,
          );
          if (!row) return undefined;
          if (row.agentInfoId !== event.targetActorId)
            throw new Error('Reaction reply actor mismatch');
          return {
            id: input.clientMessageId,
            seq: row.seq ?? 0,
            createdAt: row.createdAt,
            content: textOf(row.content),
          };
        },
      );
    },
    busy: () => conversationIsActive(event.userId, event.conversationId),
    saveDecision: async (_, decision) => {
      const saved =
        event.leaseToken !== null &&
        (await saveReactionEventDecision(getDb(), event.id, event.leaseToken, decision));
      if (!saved) owned = false;
      return saved;
    },
    recipient: async () => {
      if (!event.targetActorId || !event.responseEligible) return null;
      const [conversation, members, agent] = await Promise.all([
        findConversation(getDb(), event.userId, event.conversationId),
        listGroupMembers(getDb(), event.userId, event.conversationId),
        room.loadAgent(event.targetActorId),
      ]);
      if (
        !agent ||
        !conversation ||
        !(conversation.agentId === agent._id || members.includes(agent._id))
      )
        return null;
      // Reach was authorized with the person's session at the mutation edge. Recheck the current
      // app boundary; no requester bearer or authority is retained, and this runner has no tools.
      if ((await agentOpensOn(agent.oxyAccountId, event.surfaceApplicationId)) !== 'reachable')
        return null;
      if (await isExternalAgent(agent._id)) return null;
      return agent;
    },
  });
}
