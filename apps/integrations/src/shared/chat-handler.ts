/**
 * Core AI chat response handler — shared by all messaging adapters.
 *
 * Each adapter extracts the platform-specific message data, then calls
 * handleIncomingMessage() with platform-agnostic params + callbacks.
 */

import { generateText } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import { resolveModel, reportUsage } from './model-resolver';
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
    sessionId,
    oxyUserId,
    chatId,
    messageText,
    sendResponse,
    setTyping,
    charLimit = 4000,
    platformContext = '',
  } = params;

  const botSecret = process.env.INTEGRATIONS_SECRET;
  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

  if (!botSecret) {
    console.error(`[${platform}/Chat] INTEGRATIONS_SECRET not configured`);
    return;
  }

  try {
    // Get channel user from API
    const channelUser = await apiClient.getChannelUser(oxyUserId);

    if (!channelUser || !channelUser.isAuthenticated || !channelUser.oxyUserId) {
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
    let conversationId = channelUser.conversationId;
    if (!conversationId) {
      conversationId = uuidv4();
      await apiClient.updateConversation(oxyUserId, conversationId);
    }

    // Load conversation history (last 20 messages)
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await apiClient.getConversation(channelUser.oxyUserId, conversationId);
      if (conversation?.messages?.length) {
        messages = conversation.messages.slice(-20).map((m: any) => ({
          role: m.role,
          content: m.content,
        }));
      }
    } catch (error) {
      console.error(`[${platform}/Chat] Failed to load history:`, error);
    }

    messages.push({ role: 'user', content: messageText });

    // Resolve AI model
    const resolved = await resolveModel(
      apiBaseUrl,
      botSecret,
      channelUser.oxyUserId,
      channelUser.preferredModel || 'alia-lite',
      platform,
    );

    // Generate AI response
    const systemPrompt = `You are Alia, a helpful AI assistant. Be concise and friendly. Respond in the same language the user writes to you.${platformContext ? ' ' + platformContext : ''}`;

    const result = await generateText({
      model: resolved.model,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      maxRetries: 3,
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const fullResponse = result.text;

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

    // Save conversation
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      await apiClient
        .saveConversation(channelUser.oxyUserId, conversationId, messages)
        .catch((err) => console.error(`[${platform}/Chat] Save conversation error:`, err));
    }

    // Report usage
    if (result.usage) {
      await reportUsage(apiBaseUrl, botSecret, channelUser.oxyUserId, resolved.sessionId, {
        promptTokens: result.usage.inputTokens || 0,
        completionTokens: result.usage.outputTokens || 0,
        totalTokens: result.usage.totalTokens || 0,
      }).catch((err) => console.error(`[${platform}/Chat] Report usage error:`, err));
    }
  } catch (error: any) {
    console.error(`[${platform}/Chat] Error:`, error);
    await sendResponse('Sorry, an error occurred. Please try again.').catch(() => {});
  }
}
