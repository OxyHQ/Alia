import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { apiClient } from '../services/api-client';
import { v4 as uuidv4 } from 'uuid';
import { sendAuthRequest } from './auth';

// Process Telegram-specific components from AI response
async function processTelegramComponents(ctx: Context, response: string, currentMessage: any) {
  // Process images [TGIMAGE url="..." caption="..."]
  const imageMatches = response.matchAll(/\[TGIMAGE\s+url="([^"]+)"(?:\s+caption="([^"]*)")?\]/g);
  for (const match of imageMatches) {
    const [, url, caption] = match;
    try {
      await ctx.replyWithPhoto(url, caption ? { caption } : undefined);
    } catch (error) {
      console.error('[Chat] Failed to send image:', error);
    }
  }

  // Process documents [TGDOC url="..." filename="..." caption="..."]
  const docMatches = response.matchAll(/\[TGDOC\s+url="([^"]+)"(?:\s+filename="([^"]*)")?(?:\s+caption="([^"]*)")?\]/g);
  for (const match of docMatches) {
    const [, url, filename, caption] = match;
    try {
      await ctx.replyWithDocument(url, {
        ...(filename ? { filename } : {}),
        ...(caption ? { caption } : {})
      });
    } catch (error) {
      console.error('[Chat] Failed to send document:', error);
    }
  }

  // Process link buttons [TGLINKS title="..."]...[/TGLINKS]
  const linksMatch = response.match(/\[TGLINKS(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/TGLINKS\]/);
  if (linksMatch) {
    const [, title, linksContent] = linksMatch;
    try {
      // Parse links from JSON format
      const linkLines = linksContent.match(/\{[^}]+\}/g);
      if (linkLines && linkLines.length > 0) {
        const buttons = linkLines.map(line => {
          const parsed = JSON.parse(line);
          return [Markup.button.url(parsed.text, parsed.url)];
        });

        await ctx.reply(
          title || '🔗 Enlaces relacionados:',
          Markup.inlineKeyboard(buttons)
        );
      }
    } catch (error) {
      console.error('[Chat] Failed to parse links:', error);
    }
  }
}

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

    // Check authentication state
    if (!telegramUser || !telegramUser.isAuthenticated) {
      await sendAuthRequest(ctx);
      return;
    }

    // Validate session token exists (users who linked before the fix won't have one)
    if (!telegramUser.sessionToken) {
      await ctx.reply(
        '🔄 <b>Session Update Required</b>\n\n' +
        'Your Telegram account needs to be re-linked to refresh your session.\n' +
        'Please use /start link to reconnect your account.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Send initial "typing" action
    await ctx.sendChatAction('typing');
    let lastActionTime = Date.now();

    // Create or use existing conversation ID
    let conversationId = telegramUser.conversationId;
    if (!conversationId) {
      conversationId = uuidv4();
      await apiClient.updateTelegramConversation(telegramId, conversationId);
    }

    // Load conversation history for context
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await apiClient.getConversation(telegramUser.sessionToken, conversationId);
      if (conversation && conversation.messages && conversation.messages.length > 0) {
        // Take last 20 messages for context (to avoid token limits)
        const recentMessages = conversation.messages.slice(-20);
        messages = recentMessages.map((msg: any) => ({
          role: msg.role,
          content: msg.content
        }));
      }
    } catch (error) {
      console.error('[Chat] Failed to load conversation history:', error);
      // Continue with empty history if loading fails
    }

    // Add new user message
    messages.push({
      role: 'user',
      content: messageText
    });

    // Make API call to chat endpoint
    console.log('[Chat] Sending message to API:', messageText.substring(0, 50));
    const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telegramUser.sessionToken}`,
        'X-Telegram-Bot': 'true',
      },
      body: JSON.stringify({
        messages
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Chat] API error response:', errorText);
      throw new Error(`API error: ${response.statusText} - ${errorText}`);
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
    let chunkCount = 0;

    // Track which tool notifications have been sent to avoid duplicates
    const sentToolNotifications = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
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
            continue;
          }

          try {
            const data = JSON.parse(dataStr);

            // Handle tool calls with dynamic chat actions
            if (data.type === 'tool-call') {
              const toolName = data.toolName;

              // Only send notification once per tool type to avoid duplicates
              if (!sentToolNotifications.has(toolName)) {
                sentToolNotifications.add(toolName);

                // Send appropriate chat action and notification
                if (toolName === 'googleSearch') {
                  await ctx.sendChatAction('typing');
                  await ctx.reply('🔍 Buscando en internet...').catch(() => {});
                } else if (toolName === 'scrapeURL') {
                  await ctx.sendChatAction('typing');
                  await ctx.reply('📄 Leyendo contenido...').catch(() => {});
                } else if (toolName === 'saveUserMemory') {
                  await ctx.sendChatAction('typing');
                  await ctx.reply('💾 Guardando información...').catch(() => {});
                } else {
                  // Generic typing for other tools
                  const now = Date.now();
                  if (now - lastActionTime > 5000) { // Refresh typing every 5s
                    await ctx.sendChatAction('typing');
                    lastActionTime = now;
                  }
                }
              }
            }

            // Handle text delta events from AI SDK
            if (data.type === 'text-delta' && data.text) {
              fullResponse += data.text;

              // Refresh typing action periodically during streaming
              const now = Date.now();
              if (now - lastActionTime > 5000) {
                await ctx.sendChatAction('typing');
                lastActionTime = now;
              }

              // Show first chunk immediately for instant feedback
              if (!currentMessage && fullResponse.length > 5) {
                currentMessage = await ctx.reply(fullResponse + '...').catch(() => null);
                lastUpdateTime = now;
              }
              // Then update every 0.7s for faster streaming (balance between responsiveness and rate limits)
              else if (now - lastUpdateTime > 700) {
                if (currentMessage) {
                  await ctx.telegram.editMessageText(
                    ctx.chat!.id,
                    currentMessage.message_id,
                    undefined,
                    fullResponse + '...'
                  ).catch(() => {}); // Ignore edit errors
                }
                lastUpdateTime = now;
              }
            } else if (data.type === 'error') {
              console.error('[Chat] API error event:', data);
              throw new Error(data.error || 'Unknown error');
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    // Process reactions before cleaning response
    const reactionMatch = fullResponse.match(/\[REACT:([^\]]+)\]/);
    if (reactionMatch && 'message' in ctx && ctx.message) {
      const emoji = reactionMatch[1].trim();
      try {
        await ctx.react(emoji as any);
      } catch (reactionError) {
        // Ignore reaction errors silently
      }
    }

    // Process Telegram-specific components
    await processTelegramComponents(ctx, fullResponse, currentMessage);

    // Clean up response - remove all special tags
    fullResponse = fullResponse.replace(/\[REACT:[^\]]+\]\s*/g, '');
    fullResponse = fullResponse.replace(/\[TITLE\][^\]]*\[\/TITLE\]\s*/g, '');
    fullResponse = fullResponse.replace(/\[TGIMAGE[^\]]*\]\s*/g, '');
    fullResponse = fullResponse.replace(/\[TGLINKS[^\]]*\][\s\S]*?\[\/TGLINKS\]\s*/g, '');
    fullResponse = fullResponse.replace(/\[TGDOC[^\]]*\]\s*/g, '');
    fullResponse = fullResponse.trim();

    // Send final message (if there's text left after processing components)
    if (fullResponse) {
      if (currentMessage) {
        // Update existing streaming message with final clean response
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          currentMessage.message_id,
          undefined,
          fullResponse
        ).catch(() => {});
      } else {
        // No streaming message was created, send final response
        await ctx.reply(fullResponse).catch(() => {});
      }
    } else if (!currentMessage) {
      // No text and no streaming message means components-only response was sent
      // Nothing to do - components were already sent
    }

    // Save conversation with new messages (user message + AI response)
    if (fullResponse) {
      try {
        // Add AI response to messages array
        messages.push({
          role: 'assistant',
          content: fullResponse
        });

        // Save updated conversation
        await apiClient.saveConversation(
          telegramUser.sessionToken,
          conversationId,
          messages
        );
      } catch (error) {
        console.error('[Chat] Failed to save conversation:', error);
        // Don't fail the request if saving fails
      }
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
