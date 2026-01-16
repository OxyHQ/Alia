import { Context } from 'telegraf';
import { Markup } from 'telegraf';
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
    console.log('[Chat] Sending message to API:', messageText.substring(0, 50));
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

    console.log('[Chat] API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Chat] API error response:', errorText);
      throw new Error(`API error: ${response.statusText} - ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    console.log('[Chat] Starting to stream response...');

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let lastUpdateTime = Date.now();
    let currentMessage: any = null;
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('[Chat] Stream ended. Total chunks:', chunkCount, 'Response length:', fullResponse.length);
        break;
      }

      chunkCount++;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          // Check for completion marker
          if (dataStr === '[DONE]') {
            console.log('[Chat] Received [DONE] marker');
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
                console.log('[Chat] Updating message, length:', fullResponse.length);
                if (currentMessage) {
                  await ctx.telegram.editMessageText(
                    ctx.chat!.id,
                    currentMessage.message_id,
                    undefined,
                    fullResponse + '...'
                  ).catch((err) => console.log('[Chat] Edit error:', err.message));
                } else if (fullResponse.length > 10) { // Only create message if we have some content
                  console.log('[Chat] Creating initial message');
                  currentMessage = await ctx.reply(fullResponse + '...').catch(() => null);
                }
                lastUpdateTime = now;
              }
            } else if (data.type === 'error') {
              console.error('[Chat] API error event:', data);
              throw new Error(data.error || 'Unknown error');
            } else {
              // Log other event types for debugging
              console.log('[Chat] Event type:', data.type);
            }
          } catch (e) {
            // Skip non-JSON lines (but log for debugging)
            if (dataStr && !dataStr.includes('{')) {
              console.log('[Chat] Non-JSON data:', dataStr.substring(0, 100));
            }
          }
        }
      }
    }

    // Check if AI wants to react to the message
    // AI can include [REACT:emoji] in response
    const reactionMatch = fullResponse.match(/\[REACT:([^\]]+)\]/);
    if (reactionMatch && 'message' in ctx && ctx.message) {
      const emoji = reactionMatch[1].trim();
      try {
        // Use the string directly - telegraf accepts emoji strings
        await ctx.react(emoji as any);
        console.log('[Chat] Reacted with:', emoji);
      } catch (reactionError) {
        console.log('[Chat] Could not react:', reactionError);
      }
      // Remove the reaction tag from the response
      fullResponse = fullResponse.replace(/\[REACT:[^\]]+\]\s*/g, '').trim();
    }

    // If no message was sent yet, send the full response
    if (!currentMessage && fullResponse) {
      console.log('[Chat] Sending final response, length:', fullResponse.length);
      await ctx.reply(fullResponse).catch(() => {});
    } else if (!fullResponse) {
      console.warn('[Chat] No response received from API');
      await ctx.reply('⚠️ I received your message but got no response. Please try again.');
    }

  } catch (error: any) {
    console.error('Chat error:', error);

    // Check if it's an authentication error
    if (error.response?.status === 401 || error.message?.includes('401')) {
      await ctx.reply(
        '🔒 <b>Session Expired</b>\n\n' +
        'Your authentication session has expired.\n' +
        'Please logout and sign in again.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 Sign In Again', 'start')]
          ])
        }
      );
    } else {
      await ctx.reply(
        `❌ <b>Error Processing Message</b>\n\n` +
        `${error.message || 'An unexpected error occurred'}\n\n` +
        `<i>Please try again in a moment.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Try Again', 'retry')],
            [Markup.button.callback('📊 Check Status', 'status')]
          ])
        }
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
      '✨ <b>New Conversation Started!</b>\n\n' +
      'Your previous conversation has been saved.\n' +
      'Send me any message to begin chatting in this new conversation.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📚 View History', 'history')]
        ])
      }
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
        await ctx.reply(
          '📚 <b>No Conversations Yet</b>\n\n' +
          'Start chatting with me to create your first conversation!',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('« Back', 'start')]
            ])
          }
        );
        return;
      }

      let message = '📚 <b>Your Recent Conversations</b>\n\n';
      conversations.slice(0, 10).forEach((conv: any, index: number) => {
        const title = conv.title || 'Untitled';
        const date = new Date(conv.updatedAt || conv.createdAt).toLocaleDateString();
        const current = conv.conversationId === telegramUser.conversationId ? '▶️ ' : '  ';
        message += `${current}<b>${index + 1}.</b> ${title}\n   <i>${date}</i>\n\n`;
      });

      if (conversations.length > 10) {
        message += `\n<i>... and ${conversations.length - 10} more conversations</i>`;
      }

      await ctx.reply(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🆕 New Chat', 'new')],
          [Markup.button.callback('« Back', 'start')]
        ])
      });
    } catch (error) {
      console.error('Error fetching history:', error);
      await ctx.reply('❌ Unable to fetch conversation history.');
    }
  } catch (error) {
    console.error('History error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}
