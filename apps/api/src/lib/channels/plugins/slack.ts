import crypto from 'crypto';
import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';

export const slackPlugin: ChannelPlugin = {
  id: 'slack',

  meta: {
    id: 'slack',
    name: 'Slack',
    icon: 'slack',
    color: '#4A154B',
    textChunkLimit: 4000,
    supportsMedia: true,
    supportsThreads: true,
    supportsReactions: true,
  },

  config: {
    isConfigured: () =>
      !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET),
    getBotSecret: () => process.env.SLACK_BOT_SECRET,
    getEnvPrefix: () => 'SLACK',
  },

  outbound: {
    deliveryMode: 'direct',

    async sendText(ctx: OutboundContext): Promise<OutboundResult> {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        return { channel: 'slack', ok: false, error: 'SLACK_BOT_TOKEN not configured' };
      }

      try {
        const payload: Record<string, any> = {
          channel: ctx.to,
          text: ctx.text,
        };

        if (ctx.threadId) {
          payload.thread_ts = ctx.threadId;
        }

        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json() as any;

        if (!data.ok) {
          return { channel: 'slack', ok: false, error: `Slack API: ${data.error}` };
        }

        return { channel: 'slack', ok: true, messageId: data.ts };
      } catch (err: any) {
        return { channel: 'slack', ok: false, error: err.message };
      }
    },
  },

  normalize: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim();
      if (/^[CU][A-Z0-9]{8,}$/.test(trimmed)) return trimmed;
      const mentionMatch = trimmed.match(/^<[@#]([CU][A-Z0-9]{8,})(?:\|[^>]*)?>$/);
      if (mentionMatch) return mentionMatch[1];
      return undefined;
    },

    looksLikeTarget(raw: string): boolean {
      const trimmed = raw.trim();
      return /^[CU][A-Z0-9]{8,}$/.test(trimmed) ||
        /^<[@#][CU][A-Z0-9]{8,}(?:\|[^>]*)?>$/.test(trimmed);
    },
  },

  webhook: {
    verifySignature(req: Request): boolean {
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      if (!signingSecret) return false;

      const timestamp = req.headers['x-slack-request-timestamp'] as string;
      const signature = req.headers['x-slack-signature'] as string;

      if (!timestamp || !signature) return false;

      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
      if (parseInt(timestamp, 10) < fiveMinutesAgo) return false;

      try {
        const rawBody = typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
        const sigBasestring = `v0:${timestamp}:${rawBody}`;
        const expected = 'v0=' + crypto
          .createHmac('sha256', signingSecret)
          .update(sigBasestring)
          .digest('hex');

        return crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        );
      } catch {
        return false;
      }
    },

    parseMessage(body: any): ChannelInboundMessage | null {
      if (body.type !== 'event_callback') return null;

      const event = body.event;
      if (!event || event.type !== 'message') return null;
      if (event.subtype) return null;
      if (event.bot_id) return null;

      if (!event.text || !event.user) return null;

      return {
        channelUserId: event.user,
        chatId: event.channel,
        text: event.text,
        threadId: event.thread_ts,
        replyToId: event.thread_ts,
      };
    },
  },
};
