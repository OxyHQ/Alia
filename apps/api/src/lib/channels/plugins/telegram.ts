import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';

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

      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ctx.to,
            text: ctx.text,
            parse_mode: 'Markdown',
            ...(ctx.replyToId && {
              reply_parameters: { message_id: parseInt(ctx.replyToId, 10) },
            }),
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { channel: 'telegram', ok: false, error: `Telegram API ${res.status}: ${body}` };
        }

        const data = await res.json() as any;
        return { channel: 'telegram', ok: true, messageId: String(data.result?.message_id) };
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
};
