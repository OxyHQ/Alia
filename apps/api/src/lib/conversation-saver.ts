/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { Conversation, type ConversationSource } from '../models/conversation.js';

// Matches both [TITLE]...[/TITLE] and <TITLE>...</TITLE>
const TITLE_EXTRACT_RE = /\[TITLE\](.*?)\[\/TITLE\]|<TITLE>(.*?)<\/TITLE>/;
const TITLE_STRIP_RE = /\[TITLE\].*?\[\/TITLE\]|<TITLE>.*?<\/TITLE>/g;

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: any[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[1] || m[2]).trim();

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
}

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const { userId, conversationId, messages, assistantResponse, toolInvocations, source } = params;

  const allMessages = [
    ...messages.filter(m => m && m.role).map((m: any) => ({
      role: m.role,
      content: m.content,
      toolInvocations: m.toolInvocations,
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
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
}
