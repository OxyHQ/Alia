/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { generateText } from 'ai';
import { Conversation, type ConversationSource } from '../models/conversation.js';
import { Message } from '../models/message.js';
import { resolveModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

interface MessageContentPart {
  type: string;
  [key: string]: unknown;
}
type MessageContent = string | MessageContentPart[];

interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
}

interface AgentInfo {
  id: string;
  name: string;
  avatar: string | null;
  handle: string;
}

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

/** A message read back from storage while deciding whether we can append. */
interface StoredTail {
  seq?: number;
  role: string;
  content: unknown;
}

/** Two messages are equal for append purposes if role and content match. */
function sameMessage(a: StoredTail, b: InputMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content === b.content) return true;
  try {
    return JSON.stringify(a.content) === JSON.stringify(b.content);
  } catch {
    return false;
  }
}

/** True for a MongoDB duplicate-key error (E11000), single or bulk. */
function isDuplicateKeyError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  if (e.code === 11000) return true;
  return Array.isArray(e.writeErrors) && e.writeErrors.some(w => w?.code === 11000 || w?.err?.code === 11000);
}

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
  await Conversation.findOneAndUpdate(
    { oxyUserId: userId, conversationId },
    {
      $set: {
        lastMessage: stripTitleTags(assistantResponse).slice(0, 100),
      },
      $setOnInsert: {
        oxyUserId: userId,
        conversationId,
        title,
        source: source || 'app',
        ...(agentId && { agentId }),
      },
    },
    { upsert: true },
  );

  const filter = { conversationId, oxyUserId: userId };
  const [storedCount, lastStored] = await Promise.all([
    Message.countDocuments(filter),
    Message.findOne(filter).sort({ seq: -1, createdAt: -1 }).select('seq role content').lean<StoredTail | null>(),
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
      await Message.insertMany(
        toAppend.map((message, i) => buildStoredMessage(message, userId, conversationId, storedCount + i)),
        { ordered: true },
      );
      return;
    } catch (err) {
      // Concurrent append claimed the same seq → converge via full rewrite below.
      if (!isDuplicateKeyError(err)) throw err;
    }
  }

  // Divergence / legacy / no-seq / race → full rewrite. seq is the absolute index.
  const allMessages = [...clientHistory, ...turnTail];
  await Message.deleteMany(filter);
  if (allMessages.length > 0) {
    await Message.insertMany(
      allMessages.map((message, index) => buildStoredMessage(message, userId, conversationId, index)),
      { ordered: false },
    );
  }
}

/**
 * Generate a conversation title using a cheap model.
 * Returns the title string (or null on failure). Does NOT write to DB.
 * Can be called in parallel with the main LLM response since it only needs the user message.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  const resolved = await resolveModel('alia-lite');
  if (!resolved) {
    log.chat.warn('Title generation skipped: no model available for alia-lite');
    return null;
  }

  try {
    const model = getAIModel(resolved.keyConfig);
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'Generate a concise conversation title (max 6 words) in the same language as the user message. Return ONLY the title, no quotes or trailing punctuation.' },
        { role: 'user', content: userMessage },
      ],
      maxOutputTokens: 30,
    });

    const title = result.text.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '');
    return (title.length > 0 && title.length < 100) ? title : null;
  } catch (err) {
    log.chat.error({ err }, 'Title generation LLM call failed');
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
    const conv = await Conversation.findOne({ oxyUserId: userId, conversationId });
    if (!conv || conv.isManualTitle) return;
    const messageCount = await Message.countDocuments({ conversationId });
    if (messageCount > 3) return;

    const title = await generateTitle(userMessage);
    if (title) {
      await Conversation.updateOne(
        { oxyUserId: userId, conversationId },
        { $set: { title } },
      );
      log.chat.info({ conversationId, title }, 'Auto-generated conversation title');
    }
  } catch (err) {
    log.chat.error({ err, conversationId }, 'generateConversationTitle failed');
  }
}

function buildStoredMessage(
  message: InputMessage,
  userId: string,
  conversationId: string,
  seq: number,
): Record<string, unknown> {
  const base = {
    conversationId,
    oxyUserId: userId,
    role: message.role,
    content: message.content,
    seq,
    createdAt: new Date(),
  };

  const withToolInvocations = message.toolInvocations
    ? { ...base, toolInvocations: message.toolInvocations }
    : base;

  const withAgentInfo = message.agentInfo
    ? { ...withToolInvocations, agentInfo: message.agentInfo }
    : withToolInvocations;

  // seq is the absolute position, so the id fallback stays globally consistent
  // whether the message was written via append or full rewrite.
  const id = message.id ? message.id : `msg-${seq}`;

  return { ...withAgentInfo, id };
}
