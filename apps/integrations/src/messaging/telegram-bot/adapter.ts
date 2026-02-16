/**
 * Telegram Bot adapter — runs Telegraf with long-polling.
 *
 * Routes AI calls through the main API's /v1/chat/completions endpoint
 * so the bot gets the full system prompt, user memory, tools, etc.
 * Responses stream via SSE and are progressively edited into a Telegram message.
 */

import { Telegraf, Markup } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import type { MessagingAdapter } from '../types';
import { APIClient } from '../../shared/api-client';
import {
  handleStart,
  handleLogout,
  handleStatus,
  handleHelp,
  handleModel,
  handleModelSelection,
  handleNewConversation,
  handleHistory,
  sendAuthRequest,
} from './commands';

const apiClient = new APIClient('telegram', process.env.TELEGRAM_BOT_SECRET || '');

export class TelegramBotAdapter implements MessagingAdapter {
  name = 'telegram-bot';
  private bot: Telegraf;

  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
  }

  async initialize() {
    const bot = this.bot;

    // Set bot commands menu
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Link your Alia account' },
      { command: 'status', description: 'View account status and credits' },
      { command: 'model', description: 'Change AI model' },
      { command: 'new', description: 'Start a new conversation' },
      { command: 'history', description: 'View recent conversations' },
      { command: 'help', description: 'Show help guide' },
      { command: 'logout', description: 'Disconnect your account' },
    ]);

    // Register command handlers
    bot.command('start', handleStart);
    bot.command('logout', handleLogout);
    bot.command('status', handleStatus);
    bot.command('model', handleModel);
    bot.command('help', handleHelp);
    bot.command('new', handleNewConversation);
    bot.command('history', handleHistory);

    // Auto-answer callback queries to remove loading spinner
    bot.on('callback_query', async (ctx, next) => {
      await ctx.answerCbQuery();
      return next();
    });

    // Inline-button action handlers
    bot.action('start', handleStart);
    bot.action('logout', handleLogout);
    bot.action('status', handleStatus);
    bot.action('help', handleHelp);
    bot.action('new', handleNewConversation);
    bot.action('history', handleHistory);

    // Dynamic model selection callback
    bot.action(/^model_(.+)$/, (ctx) => {
      const modelId = ctx.match[1];
      return handleModelSelection(ctx, modelId);
    });

    // Text messages => streaming chat
    bot.on('text', async (ctx, next) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) return next();
      await this.handleChatMessage(ctx);
    });

    // Global error handler
    bot.catch((err: any, ctx: any) => {
      console.error('[Telegram Bot] Error:', err);
      ctx.reply('An error occurred. Please try again later.').catch(() => {});
    });

    // Launch with long-polling (fire-and-forget — launch() never resolves
    // because it runs an infinite getUpdates loop)
    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error('[Telegram Bot] Polling error:', err);
    });
    console.log('[Telegram Bot] Bot started (polling)');
  }

  async shutdown() {
    this.bot.stop('shutdown');
  }

  // -----------------------------------------------------------------------
  // Streaming chat handler (preserves original behaviour)
  // -----------------------------------------------------------------------
  private async handleChatMessage(ctx: any) {
    const telegramId = ctx.from?.id.toString();
    const messageText: string | undefined =
      'message' in ctx && ctx.message && 'text' in ctx.message
        ? ctx.message.text
        : undefined;

    if (!telegramId || !messageText) return;

    try {
      // Check authentication
      const channelUser = await apiClient.getChannelUser(telegramId);
      if (!channelUser || !channelUser.isAuthenticated || !channelUser.oxyUserId) {
        await sendAuthRequest(ctx);
        return;
      }

      // Typing indicator
      await ctx.sendChatAction('typing');
      let lastActionTime = Date.now();

      // Conversation management
      let conversationId = channelUser.conversationId;
      if (!conversationId) {
        conversationId = uuidv4();
        await apiClient.updateConversation(telegramId, conversationId);
      }

      // Load conversation history (last 20 messages, user/assistant only)
      let messages: Array<{ role: string; content: string }> = [];
      try {
        const conversation = await apiClient.getConversation(
          channelUser.oxyUserId.toString(),
          conversationId,
        );
        if (conversation?.messages?.length) {
          messages = conversation.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .slice(-20)
            .map((msg: any) => ({ role: msg.role, content: msg.content }));
        }
      } catch (error) {
        console.error('[Telegram Bot] Failed to load conversation history:', error);
      }

      // Append new user message
      messages.push({ role: 'user', content: messageText });

      // Platform instructions passed as first system message —
      // the API extracts this as clientContext and merges it into the full system prompt
      const apiMessages = [
        {
          role: 'system',
          content: `The user is chatting via Telegram.

Telegram Special Commands (use when appropriate):
- [ALIA_REACT:emoji] - React to user's message with an emoji (e.g., [ALIA_REACT:👍])
- [ALIA_TGIMAGE url="..." caption="..."] - Send an image
- [ALIA_TGDOC url="..." filename="..." caption="..."] - Send a document
- [ALIA_TGLINKS title="..."]{"text":"...","url":"..."}[/ALIA_TGLINKS] - Send link buttons

Be concise and friendly. Use these Telegram features when appropriate.`,
        },
        ...messages,
      ];

      // ---------- Stream response via API ----------
      let fullResponse = '';
      let lastUpdateTime = Date.now();
      let currentMessage: any = null;

      const stream = apiClient.chatCompletionStream(
        channelUser.oxyUserId.toString(),
        apiMessages,
        {
          model: channelUser.preferredModel || 'alia-lite',
          conversationId,
        },
      );

      // Process streaming chunks
      for await (const chunk of stream) {
        fullResponse += chunk;
        const now = Date.now();

        // Keep typing indicator alive
        if (now - lastActionTime > 5000) {
          await ctx.sendChatAction('typing');
          lastActionTime = now;
        }

        // Show first chunk immediately for instant feedback
        if (!currentMessage && fullResponse.length > 5) {
          currentMessage = await ctx.reply(fullResponse + '...').catch(() => null);
          lastUpdateTime = now;
        }
        // Update every 700ms (balance between responsiveness and rate limits)
        else if (now - lastUpdateTime > 700) {
          if (currentMessage) {
            await ctx.telegram
              .editMessageText(ctx.chat!.id, currentMessage.message_id, undefined, fullResponse + '...')
              .catch(() => {});
          }
          lastUpdateTime = now;
        }
      }

      // ---------- Post-processing ----------

      // Reactions
      const reactionMatch = fullResponse.match(/\[(?:ALIA_)?REACT:([^\]]+)\]/);
      if (reactionMatch && 'message' in ctx && ctx.message) {
        try {
          await ctx.react(reactionMatch[1].trim() as any);
        } catch {
          // Ignore reaction errors
        }
      }

      // Process Telegram-specific components (images, docs, links)
      await this.processTelegramComponents(ctx, fullResponse);

      // Clean special tags from response text
      fullResponse = fullResponse.replace(/\[(?:ALIA_)?REACT:[^\]]+\]\s*/g, '');
      fullResponse = fullResponse.replace(/\[(?:ALIA_)?TITLE\][^\]]*\[\/(?:ALIA_)?TITLE\]\s*/g, '');
      fullResponse = fullResponse.replace(/\[(?:ALIA_)?TGIMAGE[^\]]*\]\s*/g, '');
      fullResponse = fullResponse.replace(/\[(?:ALIA_)?TGLINKS[^\]]*\][\s\S]*?\[\/(?:ALIA_)?TGLINKS\]\s*/g, '');
      fullResponse = fullResponse.replace(/\[(?:ALIA_)?TGDOC[^\]]*\]\s*/g, '');
      fullResponse = fullResponse.trim();

      // Final message update
      if (fullResponse) {
        if (currentMessage) {
          await ctx.telegram
            .editMessageText(ctx.chat!.id, currentMessage.message_id, undefined, fullResponse)
            .catch(() => {});
        } else {
          await ctx.reply(fullResponse).catch(() => {});
        }
      }

      // Conversation is auto-saved by the API when conversationId is provided
    } catch (error: any) {
      console.error('[Telegram Bot] Chat error:', error);

      if (error.code === 'INSUFFICIENT_CREDITS' || error.status === 402) {
        const appUrl = process.env.APP_URL || 'https://alia.onl';
        await ctx.reply(
          `💳 <b>Out of Credits</b>\n\n` +
          `You've run out of credits. Add more to continue using Alia.\n\n` +
          `<a href="${appUrl}">Open Alia to add credits</a>`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } else if (error.response?.status === 401 || error.message?.includes('401')) {
        await ctx.reply(
          '🔒 <b>Session Expired</b>\n\nYour authentication session has expired.\nPlease logout and sign in again.',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔐 Sign In Again', 'start')],
            ]),
          },
        );
      } else {
        await ctx.reply(
          `❌ <b>Error Processing Message</b>\n\n${error.message || 'An unexpected error occurred'}\n\n<i>Please try again in a moment.</i>`,
          { parse_mode: 'HTML' },
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Telegram-specific components (images, docs, link buttons)
  // -----------------------------------------------------------------------
  private async processTelegramComponents(ctx: any, response: string) {
    // Images [ALIA_TGIMAGE url="..." caption="..."]
    const imageMatches = response.matchAll(/\[(?:ALIA_)?TGIMAGE\s+url="([^"]+)"(?:\s+caption="([^"]*)")?\]/g);
    for (const match of imageMatches) {
      const [, url, caption] = match;
      try {
        await ctx.replyWithPhoto(url, caption ? { caption } : undefined);
      } catch (error) {
        console.error('[Telegram Bot] Failed to send image:', error);
      }
    }

    // Documents [ALIA_TGDOC url="..." filename="..." caption="..."]
    const docMatches = response.matchAll(/\[(?:ALIA_)?TGDOC\s+url="([^"]+)"(?:\s+filename="([^"]*)")?(?:\s+caption="([^"]*)")?\]/g);
    for (const match of docMatches) {
      const [, url, filename, caption] = match;
      try {
        await ctx.replyWithDocument(url, {
          ...(filename ? { filename } : {}),
          ...(caption ? { caption } : {}),
        });
      } catch (error) {
        console.error('[Telegram Bot] Failed to send document:', error);
      }
    }

    // Link buttons [ALIA_TGLINKS title="..."]...[/ALIA_TGLINKS]
    const linksMatch = response.match(/\[(?:ALIA_)?TGLINKS(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/(?:ALIA_)?TGLINKS\]/);
    if (linksMatch) {
      const [, title, linksContent] = linksMatch;
      try {
        const linkLines = linksContent.match(/\{[^}]+\}/g);
        if (linkLines && linkLines.length > 0) {
          const buttons = linkLines.map((line) => {
            const parsed = JSON.parse(line);
            return [Markup.button.url(parsed.text, parsed.url)];
          });
          await ctx.reply(title || '🔗 Related links:', Markup.inlineKeyboard(buttons));
        }
      } catch (error) {
        console.error('[Telegram Bot] Failed to parse links:', error);
      }
    }
  }
}
