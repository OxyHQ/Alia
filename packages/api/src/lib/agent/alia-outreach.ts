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
 *
 * ## Alia's own initiative
 *
 * `postAliaCheckIn` is Alia writing first about something nobody asked for —
 * today, an important email (`lib/proactive/email-outreach.ts`). It goes into
 * ONE conversation of hers per person, whose id is derived from the person
 * ({@link aliaOutreachConversationId}) so no table has to remember it, and it
 * spends the same budget an agent's check-in does (`outreach-budget.ts`): 3 a
 * day, none while her last 2 are unanswered.
 */

import { createHash, randomUUID } from 'node:crypto';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../../db/index.js';
import { claimAutomationConversation } from '../../db/automation/automationDefinitionRepository.js';
import { findConversation, upsertConversation } from '../../db/chat/conversationRepository.js';
import {
  countOutreachInConversationSince,
  findLastMessage,
  insertMessages,
} from '../../db/chat/messageRepository.js';
import { AGENT_OUTREACH_MESSAGE_ID_PREFIX } from '../../domain/conversation.js';
import { log } from '../logger.js';
import { sendNotification } from '../notification-service.js';
import { getIO } from '../../socket.js';
import { checkInRefusal, type CheckInRefusal } from './outreach-budget.js';

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

/** Append one marked assistant message at the end of an Alia conversation and tell an open client. */
async function appendAliaMessage(oxyUserId: string, conversationId: string, title: string, content: string): Promise<string> {
  const messageId = `${AGENT_OUTREACH_MESSAGE_ID_PREFIX}${randomUUID()}`;
  // Appended at the end with the next `seq`; retried on exactly the conflict a
  // concurrent turn taking the same seq produces (see `postAgentMessage`).
  for (let attempt = 0; ; attempt++) {
    const last = await findLastMessage(getDb(), oxyUserId, conversationId);
    const seq = last?.seq == null ? 0 : last.seq + 1;
    try {
      await insertMessages(getDb(), [{
        conversationId,
        oxyUserId,
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
    oxyUserId,
    conversationId,
    lastMessage: content.slice(0, 100),
    titleOnInsert: title,
  });

  // Live, for a client that has this conversation open.
  getIO()?.to(`user:${oxyUserId}`).emit('conversation:message', {
    conversationId,
    message: { id: messageId, role: 'assistant', content, createdAt: new Date() },
  });

  return messageId;
}

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

  const messageId = await appendAliaMessage(input.oxyUserId, conversationId, title, content);

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

/**
 * The conversation Alia's own-initiative messages go to, for one person.
 *
 * Derived, not stored: a UUID (version 8, RFC 9562's "custom") from a hash of
 * the person's id, so every caller agrees on it without a lookup and a person
 * who deleted it gets it back under the same id, as a task's does.
 */
export function aliaOutreachConversationId(oxyUserId: string): string {
  const bytes = createHash('sha256').update(`alia-outreach:${oxyUserId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Whether Alia may write first to this person now — the agents' budget, before anything is spent. */
export async function aliaCheckInRefusal(oxyUserId: string): Promise<CheckInRefusal | null> {
  const conversationId = aliaOutreachConversationId(oxyUserId);
  return checkInRefusal({
    oxyUserId,
    conversationId,
    countSince: (since) => countOutreachInConversationSince(getDb(), oxyUserId, conversationId, since),
  });
}

export interface AliaCheckInInput {
  readonly oxyUserId: string;
  readonly content: string;
  /** The notification's title. */
  readonly title: string;
  /** The conversation's title the first time it is created. */
  readonly conversationTitle: string;
  /** Extra notification data, e.g. which email this is about. */
  readonly data?: Record<string, string>;
  /** Plain-text push/in-app body when it should differ from the markdown message. */
  readonly notificationBody?: string;
}

export type AliaCheckInOutcome =
  | { readonly posted: true; readonly conversationId: string; readonly messageId: string }
  | { readonly posted: false; readonly reason: 'empty' | CheckInRefusal };

/** Alia writing first, on her own initiative, budgeted like an agent's check-in. */
export async function postAliaCheckIn(input: AliaCheckInInput): Promise<AliaCheckInOutcome> {
  const content = input.content.trim().slice(0, MAX_OUTREACH_CHARS);
  if (!content) return { posted: false, reason: 'empty' };
  const refusal = await aliaCheckInRefusal(input.oxyUserId);
  if (refusal) return { posted: false, reason: refusal };

  const conversationId = aliaOutreachConversationId(input.oxyUserId);
  const title = input.conversationTitle.trim().slice(0, MAX_TITLE_CHARS) || 'Alia';
  if (!(await findConversation(getDb(), input.oxyUserId, conversationId))) {
    await upsertConversation(getDb(), {
      oxyUserId: input.oxyUserId,
      conversationId,
      titleOnInsert: title,
      source: 'app',
    });
  }
  const messageId = await appendAliaMessage(input.oxyUserId, conversationId, title, content);

  await sendNotification({
    userId: input.oxyUserId,
    type: 'proactive_insight',
    title: input.title,
    body: (input.notificationBody ?? content).slice(0, 500),
    conversationId,
    data: { conversationId, messageId, ...(input.data ?? {}) },
  }).catch((err: unknown) => log.agents.warn({ err }, 'Could not notify about an Alia check-in'));

  return { posted: true, conversationId, messageId };
}
