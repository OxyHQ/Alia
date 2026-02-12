import { Message } from 'discord.js';
import { generateText } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import { apiClient } from '../services/api-client';
import { resolveModel, reportUsage } from '../services/model-resolver';
import { sendAuthRequest } from './auth';

export async function handleMessage(message: Message): Promise<void> {
  const discordUserId = message.author.id;

  try {
    // Get channel user
    let channelUser: any;
    try {
      channelUser = await apiClient.getChannelUser(discordUserId);
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Create user and send auth
        await apiClient.createOrUpdateChannelUser({
          channelUserId: discordUserId,
          chatId: message.channel.id,
          username: message.author.username,
          displayName: message.author.displayName || message.author.username,
        });
        await sendAuthRequest(message);
        return;
      }
      throw error;
    }

    if (!channelUser?.isAuthenticated || !channelUser?.oxyUserId) {
      await sendAuthRequest(message);
      return;
    }

    // Show typing indicator
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }
    const typingInterval = setInterval(() => {
      if ('sendTyping' in message.channel) {
        message.channel.sendTyping().catch(() => {});
      }
    }, 5000);

    try {
      const botSecret = process.env.DISCORD_BOT_SECRET!;
      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

      // Create or use existing conversation
      let conversationId = channelUser.conversationId;
      if (!conversationId) {
        conversationId = uuidv4();
        await apiClient.updateConversation(discordUserId, conversationId);
      }

      // Load conversation history
      let messages_history: Array<{ role: string; content: string }> = [];
      try {
        const conversation = await apiClient.getConversation(channelUser.oxyUserId, conversationId);
        if (conversation?.messages?.length) {
          messages_history = conversation.messages.slice(-20).map((m: any) => ({
            role: m.role,
            content: m.content,
          }));
        }
      } catch (error) {
        console.error('[Chat] Failed to load history:', error);
      }

      // Add user message
      messages_history.push({ role: 'user', content: message.content });

      // Resolve AI model
      const resolved = await resolveModel(
        apiBaseUrl,
        botSecret,
        channelUser.oxyUserId,
        channelUser.preferredModel || 'alia-lite'
      );

      // Generate response
      const systemPrompt = `You are Alia, a helpful AI assistant accessible via Discord. Be concise and friendly. Use Discord markdown formatting (bold, italic, code blocks). Respond in the same language the user writes to you. Keep responses under 1800 characters when possible (Discord limit is 2000).`;

      // Send initial "thinking" message for long responses
      const thinkingMsg = await message.reply('💭 Thinking...');

      const result = await generateText({
        model: resolved.model,
        system: systemPrompt,
        messages: messages_history.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        maxRetries: 3,
        temperature: 0.7,
        maxOutputTokens: 2048,
      });

      const fullResponse = result.text;

      // Send response (with chunking for long messages)
      if (fullResponse) {
        const chunks = chunkText(fullResponse, 2000);
        // Edit the "thinking" message with first chunk
        await thinkingMsg.edit(chunks[0]);
        // Send additional chunks as follow-ups
        for (let i = 1; i < chunks.length; i++) {
          if ('send' in message.channel) {
            await message.channel.send(chunks[i]);
          }
        }
      } else {
        await thinkingMsg.edit('I couldn\'t generate a response. Please try again.');
      }

      // Save conversation
      if (fullResponse) {
        messages_history.push({ role: 'assistant', content: fullResponse });
        await apiClient.saveConversation(
          channelUser.oxyUserId,
          conversationId,
          messages_history
        ).catch(err => console.error('[Chat] Save error:', err));
      }

      // Report usage
      if (result.usage) {
        await reportUsage(
          apiBaseUrl,
          botSecret,
          channelUser.oxyUserId,
          resolved.sessionId,
          {
            promptTokens: result.usage.inputTokens || 0,
            completionTokens: result.usage.outputTokens || 0,
            totalTokens: result.usage.totalTokens || 0,
          }
        );
      }

    } finally {
      clearInterval(typingInterval);
    }

  } catch (error: any) {
    console.error('[Chat] Error:', error);
    await message.reply('❌ Sorry, an error occurred. Please try again.').catch(() => {});
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const breakAt = remaining.lastIndexOf('\n', limit) || remaining.lastIndexOf(' ', limit) || limit;
    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
