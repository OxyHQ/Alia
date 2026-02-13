import { generateText } from 'ai';
import { resolveModel, reportUsage } from '../services/model-resolver';
import { apiClient } from '../services/api-client';
import { v4 as uuidv4 } from 'uuid';
import { SignalSession } from '../models/signal-session';

/**
 * Deduplication set: keeps track of recently-processed message senders+timestamps
 * to prevent handling the same message twice (polling can return duplicates).
 */
const processedMessages = new Set<string>();

export async function handleIncomingMessage(
  sessionId: string,
  daemonPort: number,
  sender: string,
  text: string
): Promise<void> {
  // ---- Deduplication ----
  const dedupKey = `${sessionId}:${sender}:${text}:${Date.now().toString().slice(0, -3)}`;
  if (processedMessages.has(dedupKey)) return;
  processedMessages.add(dedupKey);
  // Remove from dedup set after 60 seconds
  setTimeout(() => processedMessages.delete(dedupKey), 60000);

  if (!text || !sender) return;

  const botSecret = process.env.SIGNAL_GATEWAY_SECRET;
  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

  if (!botSecret) {
    console.error('[Signal/Chat] SIGNAL_GATEWAY_SECRET not configured');
    return;
  }

  try {
    // ---- Look up oxyUserId from the session ----
    const session = await SignalSession.findOne({ sessionId }).lean();
    if (!session) {
      console.error(`[Signal/Chat] No session found for ${sessionId}`);
      return;
    }
    const oxyUserId = session.oxyUserId;

    // ---- Get channel user from API ----
    const channelUser = await apiClient.getChannelUser(oxyUserId);

    if (!channelUser || !channelUser.isAuthenticated || !channelUser.oxyUserId) {
      // User's Signal is connected but they haven't linked their Alia account
      await sendMessage(daemonPort, sender,
        'Please link your Alia account first. Visit the Alia app and go to Settings > Connect Signal.'
      );
      return;
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
      console.error('[Signal/Chat] Failed to load history:', error);
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

    // ---- Generate AI response (non-streaming for Signal) ----
    const systemPrompt = `You are Alia, a helpful AI assistant responding via Signal on the user's behalf. Be concise and friendly. Respond in the same language the user writes to you. Keep responses under 3000 characters when possible.`;

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
        await sendMessage(daemonPort, sender, chunk);
      }
    }

    // ---- Save conversation ----
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      await apiClient
        .saveConversation(channelUser.oxyUserId, conversationId, messages)
        .catch((err) => console.error('[Signal/Chat] Save conversation error:', err));
    }

    // ---- Report usage ----
    if (result.usage) {
      await reportUsage(apiBaseUrl, botSecret, channelUser.oxyUserId, resolved.sessionId, {
        promptTokens: result.usage.inputTokens || 0,
        completionTokens: result.usage.outputTokens || 0,
        totalTokens: result.usage.totalTokens || 0,
      }).catch((err) => console.error('[Signal/Chat] Report usage error:', err));
    }
  } catch (error: any) {
    console.error('[Signal/Chat] Error:', error);
    await sendMessage(daemonPort, sender, 'Sorry, an error occurred. Please try again.').catch(
      () => {}
    );
  }
}

/**
 * Send a message via the signal-cli daemon's HTTP API.
 */
async function sendMessage(daemonPort: number, recipient: string, message: string): Promise<void> {
  await fetch(`http://127.0.0.1:${daemonPort}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: [recipient],
      message,
    }),
  });
}

/**
 * Split long text into chunks that respect Signal's message length limits.
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
