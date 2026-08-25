/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { generateText } from 'ai';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../db/index.js';
import {
  findConversation,
  updateConversationTitle,
  upsertConversation,
} from '../db/chat/conversationRepository.js';
import {
  countMessages,
  countMessagesInConversation,
  deleteMessages,
  findLastMessage,
  insertMessages,
  type NewMessage,
} from '../db/chat/messageRepository.js';
import {
  type AgentInfo,
  type ConversationSource,
  type MessageContent,
  type MessageRole,
  type ToolInvocation,
} from '../domain/conversation.js';
import { resolveModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** The shape callers actually pass (a subset of ChatMessage / stored message fields). */
interface InputMessage {
  role: string;
  content?: MessageContent;
  toolInvocations?: ToolInvocation[];
  agentInfo?: AgentInfo;
  id?: string;
}

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: InputMessage[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Prefer the first user message (most descriptive of conversation topic)
  const firstUserMsg = messages.find(msg => msg.role === 'user')?.content;
  if (typeof firstUserMsg === 'string' && firstUserMsg.length > 0) return firstUserMsg.slice(0, 60);

  // Fallback: first ~6 words of cleaned response
  const cleaned = response.replace(/\[.*?\]|<.*?>|[#*_`]/g, '').trim();
  if (cleaned.length >= 10) return cleaned.split(/\s+/).slice(0, 6).join(' ');

  return 'New chat';
}

/** Remove [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags from content. */
export function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

export interface SaveConversationParams {
  userId: string;
  conversationId: string;
  messages: InputMessage[];
  assistantResponse: string;
  toolInvocations?: ToolInvocation[];
  source?: ConversationSource;
  agentId?: string;
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: AgentInfo }>;
}

/** Two messages are equal for append purposes if role and content match. */
function sameMessage(a: { role: string; content: unknown }, b: InputMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content === b.content) return true;
  try {
    return JSON.stringify(a.content) === JSON.stringify(b.content);
  } catch {
    return false;
  }
}

/**
 * The one index whose violation means "a concurrent append claimed this seq".
 *
 * Named, not just "some unique fired": `isUniqueViolation(error)` alone cannot
 * tell this index from any other on the table, so a future one would quietly
 * start triggering the full-rewrite recovery for an unrelated reason. It is also
 * why the SQLSTATE is read with `@oxyhq/db`'s helper rather than off
 * `error.code` — drizzle wraps the driver failure, so the code lives on `cause`
 * and a direct read matches nothing.
 */
const APPEND_SEQ_INDEX = 'messages_oxy_user_conversation_seq_key';

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 *
 * Messages are stored append-only: the common case (client resent the exact
 * stored history plus a new turn) inserts only the delta, keyed by a monotonic
 * `seq`. Any divergence, legacy (seq-less) history, or append race falls back to
 * a full delete + reinsert so storage always converges on the client's view.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const { userId, conversationId, messages, assistantResponse, toolInvocations, source, agentId, agentMessages } = params;

  const clientHistory = messages
    .filter(m => m != null && m.role && m.content !== undefined)
    .map(m => ({
      role: m.role,
      content: m.content,
      toolInvocations: m.toolInvocations,
    }));

  const turnTail: InputMessage[] = [
    // Insert agent messages before the final assistant response
    ...(agentMessages || []).map(am => ({
      role: am.role,
      content: am.content,
      agentInfo: am.agentInfo,
    })),
    {
      role: 'assistant',
      content: stripTitleTags(assistantResponse),
      ...(toolInvocations && toolInvocations.length > 0 && { toolInvocations }),
    },
  ].filter(msg => msg != null && msg.role && msg.content !== undefined);

  const title = extractConversationTitle(assistantResponse, messages);

  // Update conversation metadata
  await upsertConversation(getDb(), {
    oxyUserId: userId,
    conversationId,
    lastMessage: stripTitleTags(assistantResponse).slice(0, 100),
    titleOnInsert: title,
    source: source || 'app',
    ...(agentId ? { agentId } : {}),
  });

  const [storedCount, lastStored] = await Promise.all([
    countMessages(getDb(), userId, conversationId),
    findLastMessage(getDb(), userId, conversationId),
  ]);

  // Fast path: stored history is exactly the client history minus the new turn,
  // with a contiguous seq that matches the client's last echoed message.
  const canAppend =
    storedCount === clientHistory.length - 1 &&
    (storedCount === 0 ||
      (lastStored?.seq === storedCount - 1 && sameMessage(lastStored, clientHistory[storedCount - 1])));

  if (canAppend) {
    const toAppend = [...clientHistory.slice(storedCount), ...turnTail];
    if (toAppend.length === 0) return;
    try {
      await insertMessages(
        getDb(),
        toAppend.map((message, i) => buildStoredMessage(message, userId, conversationId, storedCount + i)),
      );
      return;
    } catch (err) {
      // Concurrent append claimed the same seq → converge via full rewrite below.
      if (!isUniqueViolation(err, APPEND_SEQ_INDEX)) throw err;
    }
  }

  // Divergence / legacy / no-seq / race → full rewrite. seq is the absolute index.
  const allMessages = [...clientHistory, ...turnTail];
  await deleteMessages(getDb(), userId, conversationId);
  if (allMessages.length > 0) {
    await insertMessages(
      getDb(),
      allMessages.map((message, index) => buildStoredMessage(message, userId, conversationId, index)),
    );
  }
}

/**
 * What the title call may SPEND, which is not how long a title is.
 *
 * Six words need about fifteen tokens, and this was `30` on that reasoning.
 * MEASURED against production on 2026-08-25 (UTC), on the deployment `alia-lite`
 * actually resolves to today: at a budget of 30 the answer came back
 * `finishReason: 'length'` having spent 28 of its 30 tokens on REASONING and
 * two on text, so `result.text` was the empty string. Every conversation went
 * untitled, with no error, no failed request and nothing in the logs. The same
 * prompt at 128, 256 and 512 answered `Viaje a Japón en primavera` and its
 * variants, after 104, 78 and 127 reasoning tokens respectively.
 *
 * A model that thinks before it speaks is the ordinary case now rather than
 * the exception, so the budget has to cover a preamble the prompt never asked
 * for and cannot see. 512 is four times the largest preamble measured; the
 * call is not billed to anyone's credits and runs once per conversation.
 */
const TITLE_OUTPUT_TOKEN_BUDGET = 512;

/**
 * Generate a conversation title using a cheap model.
 * Returns the title string (or null on failure). Does NOT write to DB.
 * Can be called in parallel with the main LLM response since it only needs the user message.
 *
 * ## Every way this returns `null` says so, in operator logs
 *
 * A title that never arrives is invisible from the outside: the turn streams,
 * the conversation saves, and the only symptom is a name nobody chose. So each
 * of the three exits names its own reason — no model, a call that threw, and a
 * call that succeeded and produced nothing usable. The last one is the one that
 * had no log at all, and it is the one that was firing.
 *
 * The reason belongs HERE and not at the caller, which holds only `string |
 * null` and cannot tell those apart. It goes to the log and never to the
 * response body: the provider and the deployment id are operator facts, which
 * `AGENTS.md` places on the truthful side of the line, and the client is told
 * nothing at all — it simply receives no `alia.title` event.
 *
 * `resolveModel` is INSIDE the try. It throws for an unregistered identifier or
 * a policy that forbids fallback — neither reachable for `alia-lite` today,
 * since it is registered and its preset is `cross-model` — and the throw would
 * otherwise leave this function entirely and land in the caller's catch, which
 * is the one place that cannot say what happened.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  try {
    const resolved = await resolveModel('alia-lite');
    if (!resolved) {
      log.chat.warn({ aliasModelId: 'alia-lite' }, 'Title generation skipped: no model available');
      return null;
    }

    const model = getAIModel(resolved, 'background');
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'Generate a concise conversation title (max 6 words) in the same language as the user message. Return ONLY the title, no quotes or trailing punctuation.' },
        { role: 'user', content: userMessage },
      ],
      maxOutputTokens: TITLE_OUTPUT_TOKEN_BUDGET,
    });

    const title = result.text.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '');
    if (title.length === 0 || title.length >= 100) {
      log.chat.warn(
        {
          provider: resolved.provider,
          modelId: resolved.modelId,
          finishReason: result.finishReason,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens,
          titleLength: title.length,
        },
        'Title generation produced no usable title',
      );
      return null;
    }
    return title;
  } catch (err) {
    log.chat.error({ err }, 'Title generation failed');
    return null;
  }
}

/**
 * Generate a conversation title asynchronously and save it to DB.
 * Skips if the conversation already has a meaningful title or was manually titled.
 * Used as fire-and-forget fallback for non-streaming paths.
 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  userMessage: string,
): Promise<void> {
  try {
    const conv = await findConversation(getDb(), userId, conversationId);
    if (!conv || conv.isManualTitle) return;
    const messageCount = await countMessagesInConversation(getDb(), conversationId);
    if (messageCount > 3) return;

    const title = await generateTitle(userMessage);
    if (title) {
      await updateConversationTitle(getDb(), userId, conversationId, title);
      // The title is a model summary of the user's own conversation.
      log.chat.info({ conversationId }, 'Auto-generated conversation title');
    }
  } catch (err) {
    log.chat.error({ err, conversationId }, 'generateConversationTitle failed');
  }
}

/**
 * One message, ready for `messages`.
 *
 * `role` and `content` are narrowed here rather than validated: every caller of
 * `saveConversation` is server-side (`lib/chat/provider-loop.ts` and the
 * non-streaming branch beside it), and `clientHistory` is the SAME array the
 * request was answered from — so a role outside the tuple would already have
 * been refused by the model call. The cast records that, and the column's CHECK
 * is what catches it if a future caller is not.
 */
function buildStoredMessage(
  message: InputMessage,
  userId: string,
  conversationId: string,
  seq: number,
): NewMessage {
  return {
    conversationId,
    oxyUserId: userId,
    role: message.role as MessageRole,
    content: message.content ?? '',
    seq,
    createdAt: new Date(),
    ...(message.toolInvocations ? { toolInvocations: message.toolInvocations } : {}),
    ...(message.agentInfo ? { agentInfo: message.agentInfo } : {}),
    // seq is the absolute position, so the id fallback stays globally consistent
    // whether the message was written via append or full rewrite.
    clientMessageId: message.id ? message.id : `msg-${seq}`,
  };
}
