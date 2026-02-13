import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { generateText } from 'ai';
import { resolveModel, reportUsage } from '../services/model-resolver';
import { apiClient } from '../services/api-client';
import { TelegramSession } from '../models/telegram-session';
import { v4 as uuidv4 } from 'uuid';

/**
 * Deduplication set: keeps track of recently-processed message IDs
 * to prevent handling the same message twice (GramJS can emit duplicates
 * during reconnections).
 */
const processedMessages = new Set<string>();

export async function handleIncomingMessage(
  sessionId: string,
  client: TelegramClient,
  message: any
): Promise<void> {
  // ---- Deduplication ----
  const msgId = message.id?.toString();
  if (!msgId || processedMessages.has(`${sessionId}:${msgId}`)) return;
  processedMessages.add(`${sessionId}:${msgId}`);
  // Remove from dedup set after 60 seconds
  setTimeout(() => processedMessages.delete(`${sessionId}:${msgId}`), 60000);

  // ---- Extract text content ----
  const text = message.text || message.message || '';
  if (!text) return;

  const chatId = message.chatId?.toString();
  if (!chatId) return;

  const botSecret = process.env.TELEGRAM_GATEWAY_SECRET;
  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

  if (!botSecret) {
    console.error('[Telegram/Chat] TELEGRAM_GATEWAY_SECRET not configured');
    return;
  }

  try {
    // ---- Look up oxyUserId from session document ----
    const sessionDoc = await TelegramSession.findOne({ sessionId }).lean();
    if (!sessionDoc || !sessionDoc.oxyUserId) {
      console.error(`[Telegram/Chat] No session or oxyUserId found for ${sessionId}`);
      return;
    }

    const oxyUserId = sessionDoc.oxyUserId;

    // ---- Get channel user from API ----
    const channelUser = await apiClient.getChannelUser(oxyUserId);

    if (!channelUser || !channelUser.isAuthenticated || !channelUser.oxyUserId) {
      // User's Telegram is connected but they haven't linked their Alia account
      await client.sendMessage(chatId, {
        message: 'Please link your Alia account first. Visit the Alia app and go to Settings > Connect Telegram.',
      });
      return;
    }

    // ---- Show typing indicator ----
    try {
      await client.invoke(
        new Api.messages.SetTyping({
          peer: chatId,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch {
      // Presence updates are best-effort
    }

    // ---- Conversation management ----
    let conversationId = channelUser.conversationId;
    if (!conversationId) {
      conversationId = uuidv4();
      await apiClient.updateConversation(oxyUserId, conversationId);
    }

    // ---- Load conversation history (last 20 messages) ----
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await apiClient.getConversation(
        channelUser.oxyUserId,
        conversationId
      );
      if (conversation?.messages?.length) {
        messages = conversation.messages.slice(-20).map((m: any) => ({
          role: m.role,
          content: m.content,
        }));
      }
    } catch (error) {
      console.error('[Telegram/Chat] Failed to load history:', error);
      // Continue with empty history
    }

    // Add user message
    messages.push({ role: 'user', content: text });

    // ---- Resolve AI model ----
    const resolved = await resolveModel(
      apiBaseUrl,
      botSecret,
      channelUser.oxyUserId,
      channelUser.preferredModel || 'alia-lite'
    );

    // ---- Generate AI response (non-streaming for Telegram) ----
    const systemPrompt = `You are Alia, a helpful AI assistant responding via Telegram on the user's behalf. Be concise and friendly. Respond in the same language the user writes to you. Keep responses under 4000 characters when possible.`;

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

    // ---- Send response (with chunking for long messages) ----
    if (fullResponse) {
      const chunks = chunkText(fullResponse, 4096);
      for (const chunk of chunks) {
        await client.sendMessage(chatId, { message: chunk });
      }
    }

    // ---- Cancel typing indicator ----
    try {
      await client.invoke(
        new Api.messages.SetTyping({
          peer: chatId,
          action: new Api.SendMessageCancelAction(),
        })
      );
    } catch {
      // Best-effort
    }

    // ---- Save conversation ----
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      await apiClient
        .saveConversation(channelUser.oxyUserId, conversationId, messages)
        .catch((err) => console.error('[Telegram/Chat] Save conversation error:', err));
    }

    // ---- Report usage ----
    if (result.usage) {
      await reportUsage(apiBaseUrl, botSecret, channelUser.oxyUserId, resolved.sessionId, {
        promptTokens: result.usage.inputTokens || 0,
        completionTokens: result.usage.outputTokens || 0,
        totalTokens: result.usage.totalTokens || 0,
      }).catch((err) => console.error('[Telegram/Chat] Report usage error:', err));
    }
  } catch (error: any) {
    console.error('[Telegram/Chat] Error:', error);
    await client
      .sendMessage(chatId, {
        message: 'Sorry, an error occurred. Please try again.',
      })
      .catch(() => {});
  }
}

/**
 * Split long text into chunks that respect Telegram's message length limits.
 * Prefers breaking at newlines, then spaces, and falls back to hard cut.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to break at a newline first, then a space, then hard-cut
    let breakAt = remaining.lastIndexOf('\n', limit);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', limit);
    if (breakAt <= 0) breakAt = limit;

    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
