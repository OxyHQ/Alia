/**
 * An agent writing to a person first — into its conversation with them.
 *
 * Until this existed an agent could only reach a person through a notification
 * when a background job ended: the result lived in `agent_sessions.result`
 * and a push body, never in the chat, and an agent had no way at all to check
 * in on its own. Muse, ChatGPT Tasks and Grok's bots all write into the thread,
 * and a library of autonomous agents is not autonomous without it.
 *
 * Two kinds, because they deserve different limits:
 * - `result` delivers something the person ASKED for (a goal, a scheduled
 *   task). It is never rate-limited: withholding it would lose their work.
 * - `check_in` is the agent's own initiative. It is budgeted per person and
 *   agent ({@link CHECK_IN_DAILY_LIMIT}) and stops when the person has left the
 *   agent's last messages unanswered ({@link UNANSWERED_CHECK_IN_LIMIT}) —
 *   the rule Meta applies to its AI Studio follow-ups, for the same reason.
 *
 * The message is marked with {@link AGENT_OUTREACH_MESSAGE_ID_PREFIX}, which is
 * what keeps a client that had not seen it yet from deleting it with its next
 * turn (`keepAgentOutreach`).
 */

import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  createConversation,
  findActiveThreadConversation,
  upsertConversation,
} from '../../db/chat/conversationRepository.js';
import {
  countAgentOutreachSince,
  findLastMessage,
  insertMessages,
  listLatestMessageMarks,
} from '../../db/chat/messageRepository.js';
import { AGENT_OUTREACH_MESSAGE_ID_PREFIX, isAgentOutreachMessageId } from '../../domain/conversation.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { log } from '../logger.js';
import { sendNotification } from '../notification-service.js';
import { getIO } from '../../socket.js';

/** Check-ins one agent may send one person in a rolling day. */
export const CHECK_IN_DAILY_LIMIT = 3;

/** Unanswered agent messages after which check-ins stop until the person replies. */
export const UNANSWERED_CHECK_IN_LIMIT = 2;

/** Longest message an agent may post; a result longer than this is cut, not lost — it stays on the run. */
const MAX_OUTREACH_CHARS = 8_000;

export type AgentOutreachKind = 'result' | 'check_in';

export type AgentOutreachOutcome =
  | { readonly posted: true; readonly conversationId: string; readonly messageId: string }
  | { readonly posted: false; readonly reason: 'agent_not_found' | 'daily_limit' | 'unanswered' | 'empty' };

export interface AgentOutreachInput {
  readonly oxyUserId: string;
  readonly agentId: string;
  readonly content: string;
  readonly kind: AgentOutreachKind;
  /** A short notification title; defaults to the agent's name. */
  readonly title?: string;
}

const SEQ_INDEX = 'messages_oxy_user_conversation_seq_key';

export async function postAgentMessage(input: AgentOutreachInput): Promise<AgentOutreachOutcome> {
  const content = input.content.trim().slice(0, MAX_OUTREACH_CHARS);
  if (!content) return { posted: false, reason: 'empty' };

  const found = await findAgentById(getDb(), input.agentId);
  if (!found) return { posted: false, reason: 'agent_not_found' };
  const agent = await attachAgentIdentity(found);
  const name = agentPromptName(agent);

  const conversation = (await findActiveThreadConversation(getDb(), input.oxyUserId, agent._id))
    ?? await createConversation(getDb(), {
      oxyUserId: input.oxyUserId,
      conversationId: randomUUID(),
      title: name,
      source: 'app',
      agentId: agent._id,
    });

  if (input.kind === 'check_in') {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (await countAgentOutreachSince(getDb(), input.oxyUserId, agent._id, since) >= CHECK_IN_DAILY_LIMIT) {
      return { posted: false, reason: 'daily_limit' };
    }
    const latest = await listLatestMessageMarks(getDb(), input.oxyUserId, conversation.conversationId, UNANSWERED_CHECK_IN_LIMIT);
    if (latest.length === UNANSWERED_CHECK_IN_LIMIT && latest.every((m) => isAgentOutreachMessageId(m.clientMessageId))) {
      return { posted: false, reason: 'unanswered' };
    }
  }

  const messageId = `${AGENT_OUTREACH_MESSAGE_ID_PREFIX}${randomUUID()}`;
  const agentInfo = { id: agent._id, name, color: agent.color, handle: agent.handle ?? '' };
  // Appended at the end: `seq` is the position the client renders by, and a
  // row without one would render at the TOP. A concurrent turn may take the
  // same seq, so the append is retried on exactly that conflict.
  for (let attempt = 0; ; attempt++) {
    const last = await findLastMessage(getDb(), input.oxyUserId, conversation.conversationId);
    const seq = last?.seq == null ? 0 : last.seq + 1;
    try {
      await insertMessages(getDb(), [{
        conversationId: conversation.conversationId,
        oxyUserId: input.oxyUserId,
        clientMessageId: messageId,
        role: 'assistant',
        content,
        agentInfo,
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
    conversationId: conversation.conversationId,
    lastMessage: content.slice(0, 100),
    titleOnInsert: name,
  });

  // Live, for a client that has this conversation open.
  getIO()?.to(`user:${input.oxyUserId}`).emit('conversation:message', {
    conversationId: conversation.conversationId,
    agentId: agent._id,
    agentHandle: agent.handle,
    message: { id: messageId, role: 'assistant', content, agentInfo, createdAt: new Date() },
  });

  await sendNotification({
    userId: input.oxyUserId,
    type: input.kind === 'result' ? 'agent_task_complete' : 'proactive_insight',
    title: input.title ?? name,
    body: content.slice(0, 500),
    conversationId: conversation.conversationId,
    data: { agentId: agent._id, ...(agent.handle ? { agentHandle: agent.handle } : {}), messageId },
  }).catch((err: unknown) => log.agents.warn({ err, agentId: agent._id }, 'Could not notify about an agent message'));

  return { posted: true, conversationId: conversation.conversationId, messageId };
}
