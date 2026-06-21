/**
 * Core AI chat response handler — shared by all messaging adapters.
 *
 * Each adapter extracts the platform-specific message data, then calls
 * handleIncomingMessage() with platform-agnostic params + callbacks.
 *
 * AI calls are routed through the main API's /v1/chat/completions endpoint
 * so that adapters get the full system prompt, user memory, tools, etc.
 */

import { v4 as uuidv4 } from 'uuid';
import { APIClient } from './api-client';
import { chunkText } from './utils';

export interface IncomingMessageParams {
  platform: string;
  sessionId: string;
  oxyUserId: string;
  chatId: string;
  messageText: string;
  senderName?: string;
  /** Send a response message back on this platform */
  sendResponse: (text: string) => Promise<void>;
  /** Show/hide typing indicator (best-effort) */
  setTyping?: (typing: boolean) => Promise<void>;
  /** Max chars per message (default 4000) */
  charLimit?: number;
  /** Custom system prompt suffix */
  platformContext?: string;
}

export async function handleIncomingMessage(
  params: IncomingMessageParams,
  apiClient: APIClient,
): Promise<void> {
  const {
    platform,
    oxyUserId,
    messageText,
    sendResponse,
    setTyping,
    charLimit = 4000,
    platformContext = '',
  } = params;

  try {
    // Get bot user from API
    const botUser = await apiClient.getBotUser(oxyUserId);

    if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
      await sendResponse(
        'Please link your Alia account first. Visit the Alia app and go to Settings.',
      );
      return;
    }

    // Show typing
    if (setTyping) {
      try { await setTyping(true); } catch {}
    }

    // Conversation management
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = uuidv4();
      await apiClient.updateConversation(oxyUserId, conversationId);
    }

    // Load conversation history (last 20 messages, user/assistant only)
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await apiClient.getConversation(botUser.oxyUserId, conversationId);
      if (conversation?.messages?.length) {
        messages = conversation.messages
          .filter((m: any) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map((m: any) => ({ role: m.role, content: m.content }));
      }
    } catch (error) {
      console.error(`[${platform}/Chat] Failed to load history:`, error);
    }

    messages.push({ role: 'user', content: messageText });

    // Platform instructions as first system message —
    // the API extracts this as clientContext and merges it into the full system prompt
    const apiMessages = [
      {
        role: 'system',
        content: `The user is chatting via ${platform}. Be concise and friendly.${platformContext ? ' ' + platformContext : ''}`,
      },
      ...messages,
    ];

    // Route through the main API to get system prompt, memory, tools, etc.
    const result = await apiClient.chatCompletion(
      botUser.oxyUserId,
      apiMessages,
      {
        model: botUser.preferredModel || 'alia-lite',
        conversationId,
      },
    );

    const fullResponse = result.content;

    // Send response (chunked)
    if (fullResponse) {
      const chunks = chunkText(fullResponse, charLimit);
      for (const chunk of chunks) {
        await sendResponse(chunk);
      }
    }

    // Clear typing
    if (setTyping) {
      try { await setTyping(false); } catch {}
    }

    // Conversation is auto-saved by the API when conversationId is provided
  } catch (error: any) {
    console.error(`[${platform}/Chat] Error:`, error);
    await sendResponse('Sorry, an error occurred. Please try again.').catch(() => {});
  }
}
