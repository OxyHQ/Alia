/**
 * The room engine wired to the real world: Postgres, Oxy tasks, the agent turn, the queue, the bus
 * and the room lock. `engine.ts` takes all of these as parameters; this is the one place that
 * names the real ones. Resolved lazily so importing the queue does not load the database.
 */

import { isUniqueViolation } from '@oxy.so/db';
import type { Executor } from '../../../db/index.js';
import type { RoomEngineDeps, RoomJobData } from './engine.js';
import { abandonRoomChain, processRoomStep } from './engine.js';
import { getRoomLock } from './lock.js';

const SEQ_INDEX = 'messages_oxy_user_conversation_seq_key';
/** The retries of the append, on exactly the conflict a concurrent writer claiming the same seq makes. */
const MAX_APPEND_ATTEMPTS = 4;

export interface RoomRuntime {
  readonly deps: RoomEngineDeps;
  processStep(data: RoomJobData): Promise<void>;
  abandon(data: RoomJobData): Promise<void>;
}

let runtime: RoomRuntime | null = null;

export function roomRuntime(): RoomRuntime {
  if (runtime) return runtime;
  const deps: RoomEngineDeps = {
    // A getter: the Redis client behind the lock is created on first use, not at import.
    get lock() {
      return getRoomLock();
    },
    publish: async (event) => {
      if (event.event === 'group.idle') {
        const { clearConversationActive } = await import('../activity.js');
        await clearConversationActive(event.userId, event.conversationId, event.chainId);
      }
      const { publishRoomEvent } = await import('./bus.js');
      await publishRoomEvent(event);
    },
    enqueue: async (job) => {
      const { enqueueRoomJob } = await import('./queue.js');
      await enqueueRoomJob(job);
    },
    latestPersonMessageId: async (userId, conversationId) => {
      const { getDb } = await import('../../../db/index.js');
      const { findLatestUserMessage } = await import('../../../db/chat/messageRepository.js');
      return (await findLatestUserMessage(getDb(), userId, conversationId))?.id ?? null;
    },
    loadTranscript: async (userId, conversationId) => {
      const { getDb } = await import('../../../db/index.js');
      const { listMessages, toStoredMessage } = await import(
        '../../../db/chat/messageRepository.js'
      );
      const rows = await listMessages(getDb(), userId, conversationId);
      return rows.map((row) => ({
        id: row.id,
        clientMessageId: row.clientMessageId,
        role: row.role,
        content: row.content,
        agentId: row.agentInfoId,
        seq: row.seq,
        createdAt: row.createdAt,
        reactions: Array.isArray(row.reactions) ? (row.reactions as string[]) : [],
        agentName: row.agentInfoId === null ? null : (row.agentInfoName ?? ''),
        agentInfo: toStoredMessage(row).agentInfo,
      }));
    },
    repliesSince: async (userId, conversationId, since) => {
      const { getDb } = await import('../../../db/index.js');
      const { countGroupRepliesSince } = await import('../../../db/chat/messageRepository.js');
      return countGroupRepliesSince(getDb(), userId, conversationId, since);
    },
    loadAgent: async (agentId) => {
      const { getDb } = await import('../../../db/index.js');
      const { findAgentById } = await import('../../../db/agents/agentRepository.js');
      const { attachAgentIdentity } = await import('../../agent-identity.js');
      const found = await findAgentById(getDb(), agentId);
      return found === null ? null : attachAgentIdentity(found);
    },
    select: async (input) => {
      const { selectRoomDecision } = await import('./selector.js');
      return selectRoomDecision(input);
    },
    runTurn: async (input) => {
      const { runAgentTurn } = await import('../../tools/agent-turn.js');
      return runAgentTurn(input);
    },
    storeReply: async (input) => {
      const { getDb } = await import('../../../db/index.js');
      for (let attempt = 1; ; attempt++) {
        try {
          return await appendRoomReply(getDb(), input);
        } catch (error) {
          if (attempt >= MAX_APPEND_ATTEMPTS || !isUniqueViolation(error, SEQ_INDEX)) throw error;
        }
      }
    },
    revokeTasks: async (taskIds) => {
      if (taskIds.length === 0) return;
      const { revokeOxyTask } = await import('../../oxy-task-authority.js');
      await Promise.allSettled(taskIds.map((id) => revokeOxyTask(id)));
    },
    now: () => Date.now(),
  };
  runtime = {
    deps,
    processStep: async (data) => {
      const { holdConversationActivity } = await import('../activity.js');
      const controller = new AbortController();
      const stopRenewing = await holdConversationActivity(
        data.userId,
        data.conversationId,
        data.triggerId,
        () => controller.abort(),
        { clearOnStop: false },
      );
      try {
        await processRoomStep(data, {
          ...deps,
          select: (input) => deps.select!({ ...input, signal: controller.signal }),
          runTurn: (input) => deps.runTurn({ ...input, signal: controller.signal }),
          publish: async (event) => {
            // Drain an in-flight renewal before clearing: it must not resurrect an idle chain.
            if (event.event === 'group.idle') await stopRenewing();
            await deps.publish(event);
          },
        });
      } finally {
        await stopRenewing();
      }
    },
    abandon: (data) => abandonRoomChain(data, deps),
  };
  return runtime;
}

/** The shared room reply writer, usable inside a guarded reaction transaction. */
export async function appendRoomReply(
  db: Executor,
  input: Parameters<RoomEngineDeps['storeReply']>[0],
) {
  const { findLastMessage, insertMessages } = await import('../../../db/chat/messageRepository.js');
  const { upsertConversation } = await import('../../../db/chat/conversationRepository.js');
  const { lockMessageThread } = await import('../../../db/chat/messageLock.js');
  return db.transaction(async (tx) => {
    await lockMessageThread(tx, input.userId, input.conversationId);
    const last = await findLastMessage(tx, input.userId, input.conversationId);
    const seq = last?.seq == null ? 0 : last.seq + 1;
    const createdAt = new Date();
    await insertMessages(tx, [
      {
        conversationId: input.conversationId,
        oxyUserId: input.userId,
        clientMessageId: input.clientMessageId,
        role: 'assistant',
        content: input.content,
        agentInfo: input.agentInfo,
        seq,
        createdAt,
      },
    ]);
    await upsertConversation(tx, {
      oxyUserId: input.userId,
      conversationId: input.conversationId,
      lastMessage: input.content.slice(0, 100),
      titleOnInsert: input.agentInfo.name,
    });
    return { id: input.clientMessageId, seq, createdAt };
  });
}
