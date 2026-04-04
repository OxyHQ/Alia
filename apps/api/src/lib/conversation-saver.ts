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
const TAG = String.raw`CLARITY_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: any[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Prefer the first user message (most descriptive of conversation topic)
  const firstUserMsg = messages.find((msg: any) => msg.role === 'user')?.content;
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
  messages: any[];
  assistantResponse: string;
  toolInvocations?: any[];
  source?: ConversationSource;
  agentId?: string;
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }>;
}

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const { userId, conversationId, messages, assistantResponse, toolInvocations, source, agentId, agentMessages } = params;

  const allMessages = [
    ...messages.filter(m => m && m.role).map((m: any) => ({
      role: m.role,
      content: m.content,
      toolInvocations: m.toolInvocations,
    })),
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

  // Replace messages in separate collection
  await Message.deleteMany({ conversationId, oxyUserId: userId });
  if (allMessages.length > 0) {
    await Message.insertMany(
      allMessages.map(m => ({
        conversationId,
        oxyUserId: userId,
        role: m.role,
        content: m.content,
        ...('toolInvocations' in m && m.toolInvocations ? { toolInvocations: m.toolInvocations } : {}),
        ...('agentInfo' in m && m.agentInfo ? { agentInfo: m.agentInfo } : {}),
        createdAt: new Date(),
      })),
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
  const resolved = await resolveModel('clarity-fast');
  if (!resolved) {
    log.chat.warn('Title generation skipped: no model available for clarity-fast');
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
