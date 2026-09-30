/**
 * Alia writing to a person first — the result of a task she was responsible for.
 *
 * The Alia counterpart of `agent-outreach.ts`. An agent's result lands in the
 * person's thread with that agent; Alia has no such thread, so each task gets
 * an ordinary Alia conversation of its own (no agent, titled by the task's
 * objective), claimed on the first delivery and kept in
 * `automation_definitions.conversation_id`. Every later run of the task appends
 * to it, so the person reads a task's history in one place and can reply there.
 *
 * The message carries the same `agent-push-` mark as an agent's, which is what
 * keeps a client that had not seen it from deleting it with its next turn
 * (`keepAgentOutreach`). Results are never rate-limited: withholding one would
 * lose what the person asked for.
 */

import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../../db/index.js';
import { claimAutomationConversation } from '../../db/automation/automationDefinitionRepository.js';
import { findConversation, upsertConversation } from '../../db/chat/conversationRepository.js';
import { findLastMessage, insertMessages } from '../../db/chat/messageRepository.js';
import { AGENT_OUTREACH_MESSAGE_ID_PREFIX } from '../../domain/conversation.js';
import { log } from '../logger.js';
import { sendNotification } from '../notification-service.js';
import { getIO } from '../../socket.js';

/** Longest message Alia posts; the full run stays inspectable on the run itself. */
const MAX_OUTREACH_CHARS = 8_000;

/** Longest conversation title taken from an objective. */
const MAX_TITLE_CHARS = 120;

const SEQ_INDEX = 'messages_oxy_user_conversation_seq_key';

export interface AliaTaskMessageInput {
  readonly oxyUserId: string;
  readonly automationId: string;
  /** The task's objective: the conversation's title and the notification's. */
  readonly objective: string;
  /** Already stored on the definition, when an earlier run delivered. */
  readonly conversationId: string | null;
  readonly content: string;
}

export type AliaOutreachOutcome =
  | { readonly posted: true; readonly conversationId: string; readonly messageId: string }
  | { readonly posted: false; readonly reason: 'empty' };

export async function postAliaMessage(input: AliaTaskMessageInput): Promise<AliaOutreachOutcome> {
  const content = input.content.trim().slice(0, MAX_OUTREACH_CHARS);
  if (!content) return { posted: false, reason: 'empty' };
  const title = input.objective.trim().slice(0, MAX_TITLE_CHARS) || 'Scheduled task';

  const conversationId = input.conversationId
    ?? await claimAutomationConversation(getDb(), input.automationId, randomUUID())
    // The definition vanished between the run and its delivery; still deliver.
    ?? randomUUID();

  // Created before the message, as a thread is. A person who deleted the
  // task's conversation gets it back under the same id.
  if (!(await findConversation(getDb(), input.oxyUserId, conversationId))) {
    await upsertConversation(getDb(), {
      oxyUserId: input.oxyUserId,
      conversationId,
      titleOnInsert: title,
      source: 'app',
    });
  }

  const messageId = `${AGENT_OUTREACH_MESSAGE_ID_PREFIX}${randomUUID()}`;
  // Appended at the end with the next `seq`; retried on exactly the conflict a
  // concurrent turn taking the same seq produces (see `postAgentMessage`).
  for (let attempt = 0; ; attempt++) {
    const last = await findLastMessage(getDb(), input.oxyUserId, conversationId);
    const seq = last?.seq == null ? 0 : last.seq + 1;
    try {
      await insertMessages(getDb(), [{
        conversationId,
        oxyUserId: input.oxyUserId,
        clientMessageId: messageId,
        role: 'assistant',
        content,
        seq,
        createdAt: new Date(),
      }]);
      break;
    } catch (err: unknown) {
      if (attempt >= 3 || !isUniqueViolation(err, SEQ_INDEX)) throw err;
    }
  }

  await upsertConversation(getDb(), {
    oxyUserId: input.oxyUserId,
    conversationId,
    lastMessage: content.slice(0, 100),
    titleOnInsert: title,
  });

  // Live, for a client that has this conversation open.
  getIO()?.to(`user:${input.oxyUserId}`).emit('conversation:message', {
    conversationId,
    message: { id: messageId, role: 'assistant', content, createdAt: new Date() },
  });

  await sendNotification({
    userId: input.oxyUserId,
    type: 'trigger_result',
    title,
    body: content.slice(0, 500),
    conversationId,
    data: { conversationId, automationId: input.automationId, messageId },
  }).catch((err: unknown) => log.agents.warn({ err, automationId: input.automationId }, 'Could not notify about an Alia task result'));

  return { posted: true, conversationId, messageId };
}
