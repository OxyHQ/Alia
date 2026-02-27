import crypto from 'crypto';
import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';
import { markdownToTelegramHtml, stripMarkdown } from '../telegram-format.js';
import { log } from '../../logger.js';

export const telegramPlugin: ChannelPlugin = {
  id: 'telegram',

  meta: {
    id: 'telegram',
    name: 'Telegram',
    icon: 'telegram',
    color: '#0088CC',
    textChunkLimit: 4096,
    supportsMedia: true,
    supportsThreads: true,
    supportsReactions: true,
  },

  config: {
    isConfigured: () =>
      !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_SECRET),
    getBotSecret: () => process.env.TELEGRAM_BOT_SECRET,
    getEnvPrefix: () => 'TELEGRAM',
  },

  outbound: {
    deliveryMode: 'direct',

    async sendText(ctx: OutboundContext): Promise<OutboundResult> {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return { channel: 'telegram', ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
      }

      const replyParams = ctx.replyToId
        ? { reply_parameters: { message_id: parseInt(ctx.replyToId, 10) } }
        : {};

      try {
        // Convert Markdown to Telegram HTML
        const htmlText = markdownToTelegramHtml(ctx.text);

        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ctx.to,
            text: htmlText,
            parse_mode: 'HTML',
            ...replyParams,
          }),
        });

        if (res.ok) {
          const data = await res.json() as any;
          return { channel: 'telegram', ok: true, messageId: String(data.result?.message_id) };
        }

        // HTML rejected — log the error and fall back to clean plain text
        const body = await res.text();
        log.general.warn(
          { status: res.status, error: body.slice(0, 200), htmlPreview: htmlText.slice(0, 200) },
          'Telegram rejected HTML, falling back to plain text',
        );

        if (res.status === 400) {
          const plainText = stripMarkdown(ctx.text);
          const fallbackRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ctx.to, text: plainText, ...replyParams }),
          });

          if (fallbackRes.ok) {
            const data = await fallbackRes.json() as any;
            return { channel: 'telegram', ok: true, messageId: String(data.result?.message_id) };
          }

          const fallbackBody = await fallbackRes.text();
          return { channel: 'telegram', ok: false, error: `Telegram API ${fallbackRes.status}: ${fallbackBody}` };
        }

        return { channel: 'telegram', ok: false, error: `Telegram API ${res.status}: ${body}` };
      } catch (err: any) {
        return { channel: 'telegram', ok: false, error: err.message };
      }
    },
  },

  normalize: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim();
      // Telegram numeric chat/user IDs (can be negative for groups)
      if (/^-?\d+$/.test(trimmed)) return trimmed;
      // @username format
      if (/^@[\w]{5,32}$/.test(trimmed)) return trimmed;
      return undefined;
    },

    looksLikeTarget(raw: string): boolean {
      const trimmed = raw.trim();
      return /^-?\d+$/.test(trimmed) || /^@[\w]{5,32}$/.test(trimmed);
    },
  },

  webhook: {
    verifySignature(req: Request): boolean {
      const secret = process.env.TELEGRAM_BOT_SECRET;
      if (!secret) return false;

      const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string;
      if (!headerToken) return false;

      try {
        return crypto.timingSafeEqual(
          Buffer.from(headerToken),
          Buffer.from(secret),
        );
      } catch {
        return false;
      }
    },

    parseMessage(body: any): ChannelInboundMessage | null {
      const msg = body.message ?? body.edited_message;
      if (!msg?.text || !msg.from) return null;

      // Ignore bot messages
      if (msg.from.is_bot) return null;

      const displayName = [msg.from.first_name, msg.from.last_name]
        .filter(Boolean)
        .join(' ') || undefined;

      return {
        platformUserId: String(msg.from.id),
        chatId: String(msg.chat.id),
        text: msg.text,
        username: msg.from.username,
        displayName,
        replyToId: msg.reply_to_message?.message_id
          ? String(msg.reply_to_message.message_id)
          : undefined,
      };
    },
  },
};
