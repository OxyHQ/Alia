/**
 * Starting a room's chain, at the edge where the person's request still holds their bearer.
 *
 * Everything that needs the person's own session happens here, once: who of the members they may
 * reach (`canReachAgent`, including the app they are in), storing their message, and minting the Oxy
 * task each member's turns will act under. The queue then carries only ids — never a bearer — and
 * the worker runs `runAgentTurn` as a task turn, like a background agent session does.
 */

import { findAgentById } from '../../../db/agents/agentRepository.js';
import { findLatestUserMessage } from '../../../db/chat/messageRepository.js';
import { getDb } from '../../../db/index.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import { canReachAgent } from '../../agent-account.js';
import { agentPromptName, attachAgentIdentity } from '../../agent-identity.js';
import { saveConversation } from '../../conversation-saver.js';
import { log } from '../../logger.js';
import { createOxyTask, revokeOxyTask } from '../../oxy-task-authority.js';
import type { RoomJobData } from './engine.js';
import { enqueueRoomJob } from './queue.js';
import { firstRound, type RoomMember } from './policy.js';
import { type GroupInputMessage, lastUserText } from './transcript.js';

type SaveParams = Parameters<typeof saveConversation>[0];

/** A chain that has been prepared (the person's message stored, authority minted) and not yet queued. */
export interface PreparedRoom {
  /** The person message the chain answers; events of this chain carry it as `chainId`. */
  readonly chainId: string;
  /** How many members the first round asks (the first round is settled when this many turns ended). */
  readonly firstRoundSize: number;
  /** Members the person may not reach: reported as failed, never queued. */
  readonly unreachableAgentIds: readonly string[];
  /** Queues the first step. Subscribe to the bus BEFORE calling it. */
  start(): Promise<void>;
  /** Gives the minted authority back when the chain will not run. */
  abandon(): Promise<void>;
}

export interface PrepareRoomInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly memberAgentIds: readonly string[];
  /** The client's whole history, ending in the person's new message. */
  readonly messages: readonly GroupInputMessage[];
  readonly accessToken: string | undefined;
  readonly surfaceApplicationId: string | null;
}

export type PrepareRoom = (input: PrepareRoomInput) => Promise<PreparedRoom>;

const nothingToRun = (unreachable: readonly string[]): PreparedRoom => ({
  chainId: '',
  firstRoundSize: 0,
  unreachableAgentIds: unreachable,
  start: async () => undefined,
  abandon: async () => undefined,
});

export const prepareRoom: PrepareRoom = async (input) => {
  const { userId, conversationId } = input;
  const reachable: AgentInfo[] = [];
  const unreachable: string[] = [];
  const accountOf = new Map<string, string>();
  for (const agentId of input.memberAgentIds) {
    try {
      const found = await findAgentById(getDb(), agentId);
      if (found === null) {
        unreachable.push(agentId);
        continue;
      }
      // The verdict is compared where it is read: only `reachable` opens the agent to the room.
      const reach = await canReachAgent(found, {
        oxyUserId: userId,
        accessToken: input.accessToken,
        surfaceApplicationId: input.surfaceApplicationId,
      });
      if (reach !== 'reachable') {
        unreachable.push(agentId);
        continue;
      }
      accountOf.set(agentId, found.oxyAccountId);
      const agent = await attachAgentIdentity(found);
      reachable.push({
        id: agentId,
        name: agentPromptName(agent),
        color: agent.color,
        character: agent.character,
        handle: agent.handle ?? 'unknown',
      });
    } catch (error: unknown) {
      log.general.error({ err: error, agentId }, 'Could not check a group member');
      unreachable.push(agentId);
    }
  }
  if (reachable.length === 0) return nothingToRun(unreachable);

  // The person's message is stored FIRST: the chain answers a stored message, and a member reads
  // the room from the store, never from the request.
  await saveConversation({
    userId,
    conversationId,
    messages: input.messages as unknown as SaveParams['messages'],
    assistantResponse: '',
    omitLeadReply: true,
  });
  const trigger = await findLatestUserMessage(getDb(), userId, conversationId);
  if (trigger === undefined) throw new Error('The person’s message was not stored');

  // One Oxy task per member, bound to the person's bearer now and acting as that member later. A
  // member whose task cannot be minted still talks; it just has no Oxy apps (less authority, never
  // more).
  const roster: RoomMember[] = await Promise.all(
    reachable.map(async (info): Promise<RoomMember> => {
      if (input.accessToken === undefined) return { info };
      try {
        const actorAccountId = accountOf.get(info.id);
        if (actorAccountId === undefined) return { info };
        const oxyTaskId = await createOxyTask({
          accessToken: input.accessToken,
          effectiveAccountId: userId,
          actorAccountId,
          origin: { kind: 'request', id: `room:${trigger.id}:${info.id}` },
        });
        return { info, oxyTaskId };
      } catch (error: unknown) {
        log.agents.warn({ err: error, agentId: info.id }, 'Could not mint a room member task');
        return { info };
      }
    }),
  );
  const taskIds = roster.flatMap((member) => (member.oxyTaskId ? [member.oxyTaskId] : []));

  const queue = firstRound(
    lastUserText(input.messages),
    roster.map((member) => member.info),
  );
  const [speakerId, ...pending] = queue;
  return {
    chainId: trigger.id,
    firstRoundSize: queue.length,
    unreachableAgentIds: unreachable,
    start: () =>
      enqueueRoomJob({
        userId,
        conversationId,
        triggerId: trigger.id,
        roster,
        speakerId: speakerId!,
        handedByAgentId: null,
        pending,
        depth: 0,
        replies: 0,
        turns: 0,
        lastSpeakerId: null,
        surfaceApplicationId: input.surfaceApplicationId,
      } satisfies RoomJobData),
    abandon: async () => {
      await Promise.allSettled(taskIds.map((id) => revokeOxyTask(id)));
    },
  };
};
