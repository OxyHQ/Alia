import type { WASocket } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import { generateText } from 'ai';
import { resolveModel, reportUsage } from '../services/model-resolver';
import { apiClient } from '../services/api-client';
import { v4 as uuidv4 } from 'uuid';

/**
 * Deduplication set: keeps track of recently-processed message IDs
 * to prevent handling the same message twice (Baileys can emit duplicates
 * during reconnections).
 */
const processedMessages = new Set<string>();

export async function handleIncomingMessage(
  oxyUserId: string,
  sock: WASocket,
  msg: proto.IWebMessageInfo
): Promise<void> {
  // ---- Deduplication ----
  const msgId = msg.key?.id;
  if (!msgId || processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  // Remove from dedup set after 60 seconds
  setTimeout(() => processedMessages.delete(msgId), 60000);

  // ---- Extract text content ----
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    '';

  if (!text) return;

  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) return;

  const botSecret = process.env.WHATSAPP_GATEWAY_SECRET;
  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

  if (!botSecret) {
    console.error('[WhatsApp/Chat] WHATSAPP_GATEWAY_SECRET not configured');
    return;
  }

  try {
    // ---- Get channel user from API ----
    const channelUser = await apiClient.getChannelUser(oxyUserId);

    if (!channelUser || !channelUser.isAuthenticated || !channelUser.oxyUserId) {
      // User's WhatsApp is connected but they haven't linked their Alia account
      await sock.sendMessage(remoteJid, {
        text: 'Please link your Alia account first. Visit the Alia app and go to Settings > Connect WhatsApp.',
      });
      return;
    }

    // ---- Show typing indicator ----
    try {
      await sock.presenceSubscribe(remoteJid);
      await sock.sendPresenceUpdate('composing', remoteJid);
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
      console.error('[WhatsApp/Chat] Failed to load history:', error);
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

    // ---- Generate AI response (non-streaming for WhatsApp) ----
    const systemPrompt = `You are Alia, a helpful AI assistant accessible via WhatsApp. Be concise and friendly. Respond in the same language the user writes to you. Keep responses under 3000 characters when possible.`;

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
      const chunks = chunkText(fullResponse, 4000);
      for (const chunk of chunks) {
        await sock.sendMessage(remoteJid, { text: chunk });
      }
    }

    // ---- Clear typing indicator ----
    try {
      await sock.sendPresenceUpdate('available', remoteJid);
    } catch {
      // Best-effort
    }

    // ---- Save conversation ----
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      await apiClient
        .saveConversation(channelUser.oxyUserId, conversationId, messages)
        .catch((err) => console.error('[WhatsApp/Chat] Save conversation error:', err));
    }

    // ---- Report usage ----
    if (result.usage) {
      await reportUsage(apiBaseUrl, botSecret, channelUser.oxyUserId, resolved.sessionId, {
        promptTokens: result.usage.inputTokens || 0,
        completionTokens: result.usage.outputTokens || 0,
        totalTokens: result.usage.totalTokens || 0,
      }).catch((err) => console.error('[WhatsApp/Chat] Report usage error:', err));
    }
  } catch (error: any) {
    console.error('[WhatsApp/Chat] Error:', error);
    await sock
      .sendMessage(remoteJid, {
        text: 'Sorry, an error occurred. Please try again.',
      })
      .catch(() => {});
  }
}

/**
 * Split long text into chunks that respect WhatsApp's message length limits.
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
