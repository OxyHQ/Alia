/**
 * Telegram Bot adapter — runs Telegraf with long-polling.
 *
 * Routes AI calls through the main API's /v1/chat/completions endpoint
 * so the bot gets the full system prompt, user memory, tools, etc.
 * Responses stream via SSE and are progressively edited into a Telegram message.
 */

import { Telegraf, Markup, type Context } from 'telegraf';
import type { Message, TelegramEmoji } from 'telegraf/types';
import { errorMessage, errorCode, errorStatus } from '../../shared/utils';
import { v4 as uuidv4 } from 'uuid';
import type { BotAdapter } from '../types';
import { APIClient, type MessageContent, type MessageContentPart } from '../../shared/api-client';
import { markdownToTelegramHtml, stripMarkdown } from '../../shared/telegram-format';
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
import { createLogger } from '../../shared/logger';

const apiClient = new APIClient('telegram', process.env.TELEGRAM_BOT_SECRET || '');
const logger = createLogger('TelegramBot');

export class TelegramBotAdapter implements BotAdapter {
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

    // Voice messages => transcribe, then chat
    bot.on('voice', async (ctx) => {
      await this.handleVoiceMessage(ctx);
    });

    // Audio files => transcribe, then chat
    bot.on('audio', async (ctx) => {
      await this.handleVoiceMessage(ctx);
    });

    // Photos => vision via chat
    bot.on('photo', async (ctx) => {
      await this.handlePhotoMessage(ctx);
    });

    // Global error handler
    bot.catch((err: unknown, ctx: Context) => {
      logger.error('Error:', err);
      ctx.reply('An error occurred. Please try again later.').catch(() => {});
    });

    // Launch with long-polling (fire-and-forget — launch() never resolves
    // because it runs an infinite getUpdates loop)
    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      logger.error('Polling error:', err);
    });
    logger.info('Bot started (polling)');
  }

  async shutdown() {
    this.bot.stop('shutdown');
  }

  // -----------------------------------------------------------------------
  // Streaming chat handler (preserves original behaviour)
  // -----------------------------------------------------------------------
  private async handleChatMessage(
    ctx: Context,
    options?: { textOverride?: string; imageUrl?: string },
  ) {
    const telegramId = ctx.from?.id.toString();
    const messageText: string | undefined =
      options?.textOverride ??
      ('message' in ctx && ctx.message && 'text' in ctx.message
        ? ctx.message.text
        : undefined);

    if (!telegramId || (!messageText && !options?.imageUrl)) return;

    try {
      // Check authentication
      const botUser = await apiClient.getBotUser(telegramId);
      if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
        await sendAuthRequest(ctx);
        return;
      }

      // Typing indicator
      await ctx.sendChatAction('typing');
      let lastActionTime = Date.now();

      // Conversation management
      let conversationId = botUser.conversationId;
      if (!conversationId) {
        conversationId = uuidv4();
        await apiClient.updateConversation(telegramId, conversationId);
      }

      // Load conversation history (last 20 messages, user/assistant only)
      let messages: Array<{ role: string; content: MessageContent }> = [];
      try {
        const conversation = await apiClient.getConversation(
          botUser.oxyUserId.toString(),
          conversationId,
        );
        if (conversation?.messages?.length) {
          messages = conversation.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-20)
            .map((msg) => ({ role: msg.role, content: msg.content }));
        }
      } catch (error) {
        logger.error('Failed to load conversation history:', error);
      }

      // Append new user message (multi-part if image is included)
      if (options?.imageUrl) {
        const parts: MessageContentPart[] = [];
        if (messageText) parts.push({ type: 'text', text: messageText });
        parts.push({ type: 'image_url', image_url: { url: options.imageUrl } });
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: messageText! });
      }

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
      let currentMessage: Message.TextMessage | null = null;

      const stream = apiClient.chatCompletionStream(
        botUser.oxyUserId.toString(),
        apiMessages,
        {
          model: botUser.preferredModel || 'alia-lite',
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
          currentMessage = await ctx.reply(stripMarkdown(fullResponse) + '...').catch(() => null);
          lastUpdateTime = now;
        }
        // Update every 700ms (balance between responsiveness and rate limits)
        else if (now - lastUpdateTime > 700) {
          if (currentMessage) {
            await ctx.telegram
              .editMessageText(ctx.chat!.id, currentMessage.message_id, undefined, stripMarkdown(fullResponse) + '...')
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
          await ctx.react(reactionMatch[1].trim() as TelegramEmoji);
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

      // Final message update — convert Markdown to Telegram HTML
      if (fullResponse) {
        const htmlText = markdownToTelegramHtml(fullResponse);
        try {
          if (currentMessage) {
            await ctx.telegram.editMessageText(
              ctx.chat!.id, currentMessage.message_id, undefined, htmlText, { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply(htmlText, { parse_mode: 'HTML' });
          }
        } catch {
          // HTML rejected — fall back to clean plain text
          const plainText = stripMarkdown(fullResponse);
          if (currentMessage) {
            await ctx.telegram
              .editMessageText(ctx.chat!.id, currentMessage.message_id, undefined, plainText)
              .catch(() => {});
          } else {
            await ctx.reply(plainText).catch(() => {});
          }
        }
      }

      // Conversation is auto-saved by the API when conversationId is provided
    } catch (error: unknown) {
      logger.error('Chat error:', error);

      if (errorCode(error) === 'INSUFFICIENT_CREDITS' || errorStatus(error) === 402) {
        const appUrl = process.env.APP_URL || 'https://alia.onl';
        await ctx.reply(
          `💳 <b>Out of Credits</b>\n\n` +
          `You've run out of credits. Add more to continue using Alia.\n\n` +
          `<a href="${appUrl}">Open Alia to add credits</a>`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } else if (errorStatus(error) === 401 || errorMessage(error).includes('401')) {
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
          `❌ <b>Error Processing Message</b>\n\n${errorMessage(error) || 'An unexpected error occurred'}\n\n<i>Please try again in a moment.</i>`,
          { parse_mode: 'HTML' },
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Media message handlers
  // -----------------------------------------------------------------------

  /**
   * Download a Telegram file by file_id and return it as a base64 string.
   */
  private async downloadTelegramFile(ctx: Context, fileId: string): Promise<string> {
    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl.href);
    if (!response.ok) throw new Error(`Failed to download file: HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  }

  /**
   * Handle voice/audio messages: download, transcribe, then pass text to chat.
   */
  private async handleVoiceMessage(ctx: Context) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
      const botUser = await apiClient.getBotUser(telegramId);
      if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
        await sendAuthRequest(ctx);
        return;
      }

      await ctx.sendChatAction('typing');

      const msg = ctx.message;
      const voice = msg && 'voice' in msg ? msg.voice : undefined;
      const audio = msg && 'audio' in msg ? msg.audio : undefined;
      const fileObj = voice || audio;

      if (!fileObj?.file_id) {
        await ctx.reply('Could not process this audio message.');
        return;
      }

      // Telegram Bot API file download limit is 20MB
      if (fileObj.file_size && fileObj.file_size > 20 * 1024 * 1024) {
        await ctx.reply('This audio file is too large (max 20MB). Please send a shorter recording.');
        return;
      }

      const base64Audio = await this.downloadTelegramFile(ctx, fileObj.file_id);
      const mimeType = voice ? 'audio/ogg' : (audio?.mime_type || 'audio/mpeg');

      const transcribedText = await apiClient.transcribe(
        botUser.oxyUserId.toString(),
        base64Audio,
        mimeType,
      );

      if (!transcribedText?.trim()) {
        await ctx.reply("I couldn't understand the audio. Could you try again or type your message?");
        return;
      }

      await this.handleChatMessage(ctx, { textOverride: transcribedText });
    } catch (error: unknown) {
      logger.error('Voice message error:', error);

      if (errorStatus(error) === 402 || errorCode(error) === 'INSUFFICIENT_CREDITS') {
        const appUrl = process.env.APP_URL || 'https://alia.onl';
        await ctx.reply(
          `You've run out of credits. Add more to continue using Alia.\n\n${appUrl}`,
        ).catch(() => {});
      } else {
        await ctx.reply('Sorry, I had trouble processing that audio. Please try again or type your message.').catch(() => {});
      }
    }
  }

  /**
   * Handle photo messages: download, build data URL, pass to vision-capable chat.
   */
  private async handlePhotoMessage(ctx: Context) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
      const botUser = await apiClient.getBotUser(telegramId);
      if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
        await sendAuthRequest(ctx);
        return;
      }

      await ctx.sendChatAction('typing');

      const photoMsg = ctx.message;
      const photos = photoMsg && 'photo' in photoMsg ? photoMsg.photo : undefined;
      if (!photos || photos.length === 0) {
        await ctx.reply('Could not process this image.');
        return;
      }

      // Pick the largest photo (last in array)
      const largestPhoto = photos[photos.length - 1];

      if (largestPhoto.file_size && largestPhoto.file_size > 20 * 1024 * 1024) {
        await ctx.reply('This image is too large to process (max 20MB).');
        return;
      }

      const base64Image = await this.downloadTelegramFile(ctx, largestPhoto.file_id);
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;
      const caption = photoMsg && 'caption' in photoMsg ? photoMsg.caption : undefined;

      await this.handleChatMessage(ctx, { textOverride: caption, imageUrl: dataUrl });
    } catch (error: unknown) {
      logger.error('Photo message error:', error);
      await ctx.reply('Sorry, I had trouble processing that image. Please try again.').catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Telegram-specific components (images, docs, link buttons)
  // -----------------------------------------------------------------------
  private async processTelegramComponents(ctx: Context, response: string) {
    // Images [ALIA_TGIMAGE url="..." caption="..."]
    const imageMatches = response.matchAll(/\[(?:ALIA_)?TGIMAGE\s+url="([^"]+)"(?:\s+caption="([^"]*)")?\]/g);
    for (const match of imageMatches) {
      const [, url, caption] = match;
      try {
        await ctx.replyWithPhoto(url, caption ? { caption } : undefined);
      } catch (error) {
        logger.error('Failed to send image:', error);
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
        logger.error('Failed to send document:', error);
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
        logger.error('Failed to parse links:', error);
      }
    }
  }
}
