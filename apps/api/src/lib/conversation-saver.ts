/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { generateText } from 'ai';
import { Conversation, type ConversationSource } from '../models/conversation.js';
import { resolveModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: any[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Fallback: first ~6 words of cleaned response
  const cleaned = response.replace(/\[.*?\]|<.*?>|[#*_`]/g, '').trim();
  if (cleaned.length >= 10) return cleaned.split(/\s+/).slice(0, 6).join(' ');

  // Final fallback: first user message or default
  const firstUserMsg = messages.find((msg: any) => msg.role === 'user')?.content;
  if (typeof firstUserMsg === 'string' && firstUserMsg.length > 0) return firstUserMsg.slice(0, 50);

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

  await Conversation.findOneAndUpdate(
    { oxyUserId: userId, conversationId },
    {
      $set: {
        title,
        lastMessage: stripTitleTags(assistantResponse).slice(0, 100),
        messages: allMessages,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        oxyUserId: userId,
        conversationId,
        source: source || 'app',
        ...(agentId && { agentId }),
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
}

/**
 * Generate a conversation title asynchronously using a cheap model.
 * Skips if the conversation already has a meaningful title or was manually titled.
 * Designed to be called fire-and-forget after saveConversation().
 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const conv = await Conversation.findOne({ oxyUserId: userId, conversationId });
  if (!conv || conv.isManualTitle) return;
  // Only generate on the first exchange (≤3 messages: system + user + assistant).
  // After that, the title from the first generation is kept.
  if (conv.messages && conv.messages.length > 3) return;

  const resolved = await resolveModel('alia-lite');
  if (!resolved) return;

  const model = getAIModel(resolved.keyConfig);
  const result = await generateText({
    model,
    messages: [
      { role: 'system', content: 'Generate a concise conversation title (max 6 words) in the same language as the user message. Return ONLY the title text, nothing else. No quotes, no punctuation at the end.' },
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantResponse.slice(0, 500) },
      { role: 'user', content: 'Title:' },
    ],
    maxTokens: 30,
  });

  const title = result.text.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '');
  if (title.length > 0 && title.length < 100) {
    await Conversation.updateOne(
      { oxyUserId: userId, conversationId },
      { $set: { title } },
    );
    log.chat.info({ conversationId, title }, 'Auto-generated conversation title');
  }
}
