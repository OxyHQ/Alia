/**
 * Core AI chat response handler — shared by all messaging adapters.
 *
 * Each adapter extracts the platform-specific message data, then calls
 * handleIncomingMessage() with platform-agnostic params + callbacks.
 *
 * AI calls are routed through the main API's /alia/chat product runtime
 * so that adapters get the full system prompt, user memory, tools, etc.
 */

import { createHash } from 'node:crypto';
import type { APIClient } from './api-client';
import { chunkText } from './utils';
import { createLogger } from './logger';

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
    messageText,
    sendResponse,
    setTyping,
    charLimit = 4000,
    platformContext = '',
  } = params;

  const logger = createLogger(`${platform}/Chat`);

  try {
    const identity = { kind: 'account' as const, sessionId: params.sessionId };
    // Show typing
    if (setTyping) {
      try {
        await setTyping(true);
      } catch (error) {
        // Typing indicator is best-effort; a failure must not interrupt the reply.
        logger.debug('Failed to start typing indicator:', error);
      }
    }

    // Stable within this connected channel conversation; the API separately binds its owner.
    const conversationId = createHash('sha256')
      .update(JSON.stringify([platform, params.sessionId, params.chatId]))
      .digest('hex');

    // Load conversation history (last 20 messages, user/assistant only)
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await apiClient.getConversation(identity, conversationId);
      if (conversation?.messages?.length) {
        messages = conversation.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }));
      }
    } catch (error) {
      logger.error('Failed to load history:', error);
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
    const result = await apiClient.chatCompletion(identity, apiMessages, {
      // Unset, or no longer in the catalogue, means the request names no
      // model and the server's default applies. See `./catalogue.ts`.
      model: await apiClient.requestModel(undefined),
      conversationId,
    });

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
      try {
        await setTyping(false);
      } catch (error) {
        // Typing indicator is best-effort; a failure must not interrupt the reply.
        logger.debug('Failed to clear typing indicator:', error);
      }
    }

    // Conversation is auto-saved by the API when conversationId is provided
  } catch (error: unknown) {
    logger.error('Error:', error);
    await sendResponse('Sorry, an error occurred. Please try again.').catch(() => {});
  }
}
