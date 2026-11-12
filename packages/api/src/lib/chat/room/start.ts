/**
 * Starting a room's chain, at the edge where the person's request still holds their bearer.
 *
 * Everything that needs the person's own session happens here, once: who of the members they may
 * reach (`canReachAgent`, including the app they are in), storing their message, and minting the Oxy
 * task each member's turns will act under. The queue then carries only ids — never a bearer — and
 * the worker runs `runAgentTurn` as a task turn, like a background agent session does.
 */

import { randomUUID } from 'node:crypto';
import { findAgentById } from '../../../db/agents/agentRepository.js';
import { findLatestUserMessage, listMessages } from '../../../db/chat/messageRepository.js';
import { findSpaceByConversation } from '../../../db/spaces/spaceRepository.js';
import { getDb } from '../../../db/index.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import { canReachAgent } from '../../agent-account.js';
import { agentPromptName, attachAgentIdentity } from '../../agent-identity.js';
import { saveConversation } from '../../conversation-saver.js';
import { log } from '../../logger.js';
import { createOxyTask, revokeOxyTask } from '../../oxy-task-authority.js';
import type { RoomJobData } from './engine.js';
import { enqueueRoomJob } from './queue.js';
import type { RoomMember } from './policy.js';
import type { GroupInputMessage } from './transcript.js';

type SaveParams = Parameters<typeof saveConversation>[0];

/** A chain that has been prepared (the person's message stored, authority minted) and not yet queued. */
export interface PreparedRoom {
  /** The person message the chain answers; events of this chain carry it as `chainId`. */
  readonly chainId: string;
  /** Whether at least one member is available for selection. */
  readonly ready: boolean;
  /** Queues the first step. Subscribe to the bus BEFORE calling it. */
  start(): Promise<void>;
  /** Gives the minted authority back when the chain will not run. */
  abandon(): Promise<void>;
}

interface PrepareRoomInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly memberAgentIds: readonly string[];
  /** The client's whole history, ending in the person's new message. */
  readonly messages: readonly GroupInputMessage[];
  readonly accessToken: string | undefined;
  readonly surfaceApplicationId: string | null;
}

export type PrepareRoom = (input: PrepareRoomInput) => Promise<PreparedRoom>;

export const prepareRoom: PrepareRoom = async (input) => {
  const { userId, conversationId } = input;
  const members: RoomMember[] = [];
  const accountOf = new Map<string, string>();
  for (const agentId of input.memberAgentIds) {
    let info: AgentInfo = {
      id: agentId,
      name: 'Unavailable member',
      handle: '',
      color: null,
      character: null,
    };
    try {
      const found = await findAgentById(getDb(), agentId);
      if (found === null) {
        members.push({ info, available: false });
        continue;
      }
      const agent = await attachAgentIdentity(found);
      info = {
        id: agentId,
        name: agentPromptName(agent),
        color: agent.color,
        character: agent.character,
        handle: agent.handle ?? '',
      };
      // The verdict is compared where it is read: only `reachable` opens the agent to the room.
      const reach = await canReachAgent(found, {
        oxyUserId: userId,
        accessToken: input.accessToken,
        surfaceApplicationId: input.surfaceApplicationId,
      });
      if (reach !== 'reachable') {
        members.push({ info, available: false });
        continue;
      }
      accountOf.set(agentId, found.oxyAccountId);
      members.push({ info, available: true, description: found.description });
    } catch (error: unknown) {
      log.general.error({ err: error, agentId }, 'Could not check a group member');
      members.push({ info, available: false });
    }
  }

  // The person's message is stored FIRST: the chain answers a stored message, and a member reads
  // the room from the store, never from the request.
  const messages = [...input.messages];
  const last = messages.at(-1);
  if (!last || last.role !== 'user') throw new Error('Room trigger must be a user message');
  const triggerClientId = last.id ?? randomUUID();
  messages[messages.length - 1] = { ...last, id: triggerClientId };
  await saveConversation({
    userId,
    conversationId,
    messages: messages as unknown as SaveParams['messages'],
    assistantResponse: '',
    omitLeadReply: true,
  });
  const latest = await findLatestUserMessage(getDb(), userId, conversationId);
  const trigger =
    latest?.clientMessageId === triggerClientId
      ? latest
      : (await listMessages(getDb(), userId, conversationId)).find(
          (row) => row.clientMessageId === triggerClientId,
        );
  if (trigger === undefined) throw new Error('The person’s message was not stored');

  // Fetch everything that can fail before minting task authority.
  const space = await findSpaceByConversation(getDb(), userId, conversationId);
  const spaceBrief = space ? { name: space.name, instructions: space.instructions } : null;

  // One Oxy task per member, bound to the person's bearer now and acting as that member later. A
  // member whose task cannot be minted still talks; it just has no Oxy apps (less authority, never
  // more).
  const roster: RoomMember[] = await Promise.all(
    members.map(async (member): Promise<RoomMember> => {
      const { info } = member;
      if (member.available === false || input.accessToken === undefined) return member;
      try {
        const actorAccountId = accountOf.get(info.id);
        if (actorAccountId === undefined) return member;
        const oxyTaskId = await createOxyTask({
          accessToken: input.accessToken,
          effectiveAccountId: userId,
          actorAccountId,
          origin: { kind: 'request', id: `room:${trigger.id}:${info.id}` },
        });
        return { ...member, oxyTaskId };
      } catch (error: unknown) {
        log.agents.warn({ err: error, agentId: info.id }, 'Could not mint a room member task');
        return member;
      }
    }),
  );
  const taskIds = roster.flatMap((member) => (member.oxyTaskId ? [member.oxyTaskId] : []));

  return {
    chainId: trigger.id,
    ready: roster.some((member) => member.available !== false),
    start: () =>
      enqueueRoomJob({
        version: 2,
        phase: 'select',
        userId,
        conversationId,
        triggerId: trigger.id,
        roster,
        speakerId: '',
        handedByAgentId: null,
        pending: [],
        depth: 0,
        replies: 0,
        turns: 0,
        lastSpeakerId: null,
        surfaceApplicationId: input.surfaceApplicationId,
        space: spaceBrief,
      } satisfies RoomJobData),
    abandon: async () => {
      await Promise.allSettled(taskIds.map((id) => revokeOxyTask(id)));
    },
  };
};
