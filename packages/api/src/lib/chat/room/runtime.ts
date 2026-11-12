/**
 * The room engine wired to the real world: Postgres, Oxy tasks, the agent turn, the queue, the bus
 * and the room lock. `engine.ts` takes all of these as parameters; this is the one place that
 * names the real ones. Resolved lazily so importing the queue does not load the database.
 */

import { isUniqueViolation } from '@oxy.so/db';
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
      const { listMessages } = await import('../../../db/chat/messageRepository.js');
      const rows = await listMessages(getDb(), userId, conversationId);
      return rows.map((row) => ({
        id: row.id,
        clientMessageId: row.clientMessageId,
        role: row.role,
        content: row.content,
        agentId: row.agentInfoId,
        seq: row.seq,
        createdAt: row.createdAt,
        agentName: row.agentInfoId === null ? null : (row.agentInfoName ?? ''),
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
      const { findLastMessage, insertMessages } = await import(
        '../../../db/chat/messageRepository.js'
      );
      const { upsertConversation } = await import('../../../db/chat/conversationRepository.js');
      const db = getDb();
      // Appended at the end: `seq` is where the client renders the message, and a concurrent
      // writer (the person's next message, another room) may take the same one — retried on that.
      for (let attempt = 1; ; attempt++) {
        const last = await findLastMessage(db, input.userId, input.conversationId);
        const seq = last?.seq == null ? 0 : last.seq + 1;
        const createdAt = new Date();
        try {
          await insertMessages(db, [
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
          await upsertConversation(db, {
            oxyUserId: input.userId,
            conversationId: input.conversationId,
            lastMessage: input.content.slice(0, 100),
            titleOnInsert: input.agentInfo.name,
          });
          return { id: input.clientMessageId, seq, createdAt };
        } catch (err: unknown) {
          if (attempt >= MAX_APPEND_ATTEMPTS || !isUniqueViolation(err, SEQ_INDEX)) throw err;
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
      await processRoomStep(data, deps);
    },
    abandon: (data) => abandonRoomChain(data, deps),
  };
  return runtime;
}
