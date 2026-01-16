import { Context } from 'telegraf';
import { TelegramUser } from '../models/telegram-user';
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

  // Get telegram user
  const telegramUser = await TelegramUser.findOne({ telegramId });

  if (!telegramUser || !telegramUser.isAuthenticated || !telegramUser.sessionToken) {
    // Send authentication request
    await sendAuthRequest(ctx);
    return;
  }

  try {
    // Send "typing" action
    await ctx.sendChatAction('typing');

    // Create or use existing conversation ID
    if (!telegramUser.conversationId) {
      telegramUser.conversationId = uuidv4();
      await telegramUser.save();
    }

    // Make API call to chat endpoint
    const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telegramUser.sessionToken}`,
      },
      body: JSON.stringify({
        message: messageText,
        conversationId: telegramUser.conversationId,
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
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === 'content') {
              fullResponse += data.content;

              // Update message every 1 second or when response is complete
              const now = Date.now();
              if (now - lastUpdateTime > 1000) {
                if (currentMessage) {
                  await ctx.telegram.editMessageText(
                    ctx.chat!.id,
                    currentMessage.message_id,
                    undefined,
                    fullResponse + '...',
                    { parse_mode: 'Markdown' }
                  ).catch(() => {}); // Ignore errors from editing
                } else {
                  currentMessage = await ctx.reply(fullResponse + '...', {
                    parse_mode: 'Markdown'
                  }).catch(() =>
                    ctx.reply(fullResponse + '...')
                  );
                }
                lastUpdateTime = now;
              }
            } else if (data.type === 'done') {
              // Send final response
              if (currentMessage) {
                await ctx.telegram.editMessageText(
                  ctx.chat!.id,
                  currentMessage.message_id,
                  undefined,
                  fullResponse || 'No response',
                  { parse_mode: 'Markdown' }
                ).catch(() =>
                  ctx.telegram.editMessageText(
                    ctx.chat!.id,
                    currentMessage.message_id,
                    undefined,
                    fullResponse || 'No response'
                  )
                );
              } else {
                await ctx.reply(fullResponse || 'No response', {
                  parse_mode: 'Markdown'
                }).catch(() =>
                  ctx.reply(fullResponse || 'No response')
                );
              }
            } else if (data.type === 'error') {
              throw new Error(data.error || 'Unknown error');
            }
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    }

    // If no message was sent yet, send the full response
    if (!currentMessage && fullResponse) {
      await ctx.reply(fullResponse, { parse_mode: 'Markdown' }).catch(() =>
        ctx.reply(fullResponse)
      );
    }

  } catch (error: any) {
    console.error('Chat error:', error);

    // Check if it's an authentication error
    if (error.response?.status === 401 || error.message?.includes('401')) {
      telegramUser.isAuthenticated = false;
      telegramUser.sessionToken = undefined;
      await telegramUser.save();

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

  const telegramUser = await TelegramUser.findOne({ telegramId });
  if (!telegramUser || !telegramUser.isAuthenticated) {
    await sendAuthRequest(ctx);
    return;
  }

  // Create new conversation ID
  telegramUser.conversationId = uuidv4();
  await telegramUser.save();

  await ctx.reply(
    '✅ New conversation started!\n\n' +
    'Send me a message to begin chatting.'
  );
}

export async function handleHistory(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  const telegramUser = await TelegramUser.findOne({ telegramId });
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
}
