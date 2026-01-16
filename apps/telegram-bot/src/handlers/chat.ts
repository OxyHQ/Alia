import { Context } from 'telegraf';
import { apiClient } from '../services/api-client';
import { v4 as uuidv4 } from 'uuid';
import { sendAuthRequest } from './auth';

export async function handleMessage(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  const messageText = 'message' in ctx && ctx.message && 'text' in ctx.message
    ? ctx.message.text
    : undefined;

  if (!telegramId || !messageText) {
    return;
  }

  try {
    // Get telegram user
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated || !telegramUser.sessionToken) {
      // Send authentication request
      await sendAuthRequest(ctx);
      return;
    }

    // Send "typing" action
    await ctx.sendChatAction('typing');

    // Create or use existing conversation ID
    let conversationId = telegramUser.conversationId;
    if (!conversationId) {
      conversationId = uuidv4();
      await apiClient.updateTelegramConversation(telegramId, conversationId);
    }

    // Get conversation history (we'll implement this simply for now - just send the current message)
    // In the future, you could fetch conversation history from the API and include it
    const messages = [
      {
        role: 'user',
        content: messageText
      }
    ];

    // Make API call to chat endpoint
    const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telegramUser.sessionToken}`,
      },
      body: JSON.stringify({
        messages
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let lastUpdateTime = Date.now();
    let currentMessage: any = null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          // Check for completion marker
          if (dataStr === '[DONE]') {
            // Send final response
            if (currentMessage && fullResponse) {
              await ctx.telegram.editMessageText(
                ctx.chat!.id,
                currentMessage.message_id,
                undefined,
                fullResponse
              ).catch(() => {}); // Ignore errors
            } else if (fullResponse) {
              await ctx.reply(fullResponse).catch(() => {});
            }
            continue;
          }

          try {
            const data = JSON.parse(dataStr);

            // Handle text delta events from AI SDK
            if (data.type === 'text-delta' && data.textDelta) {
              fullResponse += data.textDelta;

              // Update message every 1.5 seconds
              const now = Date.now();
              if (now - lastUpdateTime > 1500) {
                if (currentMessage) {
                  await ctx.telegram.editMessageText(
                    ctx.chat!.id,
                    currentMessage.message_id,
                    undefined,
                    fullResponse + '...'
                  ).catch(() => {}); // Ignore errors from editing
                } else if (fullResponse.length > 10) { // Only create message if we have some content
                  currentMessage = await ctx.reply(fullResponse + '...').catch(() => null);
                }
                lastUpdateTime = now;
              }
            } else if (data.type === 'error') {
              throw new Error(data.error || 'Unknown error');
            }
            // Ignore other event types (tool-call, tool-result, finish, etc.)
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    // If no message was sent yet, send the full response
    if (!currentMessage && fullResponse) {
      await ctx.reply(fullResponse).catch(() => {});
    }

  } catch (error: any) {
    console.error('Chat error:', error);

    // Check if it's an authentication error
    if (error.response?.status === 401 || error.message?.includes('401')) {
      await ctx.reply(
        '❌ Your session has expired.\n\n' +
        'Please /logout and /start again to re-authenticate.'
      );
    } else {
      await ctx.reply(
        `❌ Sorry, I encountered an error processing your message.\n\n` +
        `Error: ${error.message || 'Unknown error'}\n\n` +
        `Please try again or contact support if the issue persists.`
      );
    }
  }
}

export async function handleNewConversation(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated) {
      await sendAuthRequest(ctx);
      return;
    }

    // Create new conversation ID
    const newConversationId = uuidv4();
    await apiClient.updateTelegramConversation(telegramId, newConversationId);

    await ctx.reply(
      '✅ New conversation started!\n\n' +
      'Send me a message to begin chatting.'
    );
  } catch (error) {
    console.error('New conversation error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

export async function handleHistory(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated || !telegramUser.sessionToken) {
      await sendAuthRequest(ctx);
      return;
    }

    try {
      const conversations = await apiClient.getConversations(telegramUser.sessionToken);

      if (!conversations || conversations.length === 0) {
        await ctx.reply('You have no conversation history yet.');
        return;
      }

      let message = '📚 Your Conversations:\n\n';
      conversations.slice(0, 10).forEach((conv: any, index: number) => {
        const title = conv.title || 'Untitled';
        const date = new Date(conv.updatedAt || conv.createdAt).toLocaleDateString();
        const current = conv.conversationId === telegramUser.conversationId ? '🔹 ' : '';
        message += `${current}${index + 1}. ${title} (${date})\n`;
      });

      if (conversations.length > 10) {
        message += `\n... and ${conversations.length - 10} more`;
      }

      await ctx.reply(message);
    } catch (error) {
      console.error('Error fetching history:', error);
      await ctx.reply('❌ Unable to fetch conversation history.');
    }
  } catch (error) {
    console.error('History error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}
