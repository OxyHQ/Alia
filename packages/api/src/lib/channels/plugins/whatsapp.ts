import crypto from 'crypto';
import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';
import { getErrorMessage } from '../../errors/index.js';

interface WhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
}

export const whatsappPlugin: ChannelPlugin = {
  id: 'whatsapp',

  meta: {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: 'whatsapp',
    color: '#25D366',
    textChunkLimit: 4000,
    supportsMedia: true,
    supportsThreads: false,
    supportsReactions: true,
  },

  config: {
    isConfigured: () =>
      !!(process.env.WHATSAPP_PHONE_NUMBER_ID &&
        process.env.WHATSAPP_ACCESS_TOKEN &&
        process.env.WHATSAPP_VERIFY_TOKEN),
    getBotSecret: () => process.env.WHATSAPP_BOT_SECRET,
    getEnvPrefix: () => 'WHATSAPP',
  },

  outbound: {
    deliveryMode: 'direct',

    async sendText(ctx: OutboundContext): Promise<OutboundResult> {
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

      if (!phoneNumberId || !accessToken) {
        return { channel: 'whatsapp', ok: false, error: 'WhatsApp credentials not configured' };
      }

      try {
        const res = await fetch(
          `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: ctx.to,
              type: 'text',
              text: { body: ctx.text },
              ...(ctx.replyToId && {
                context: { message_id: ctx.replyToId },
              }),
            }),
          }
        );

        if (!res.ok) {
          const body = await res.text();
          return { channel: 'whatsapp', ok: false, error: `WhatsApp API ${res.status}: ${body}` };
        }

        const data = await res.json() as WhatsAppSendResponse;
        const messageId = data.messages?.[0]?.id;
        return { channel: 'whatsapp', ok: true, messageId };
      } catch (err: unknown) {
        return { channel: 'whatsapp', ok: false, error: getErrorMessage(err) };
      }
    },
  },

  normalize: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim().replace(/^\+/, '');
      if (/^\d{7,15}$/.test(trimmed)) return trimmed;
      if (/^\d+@(g|s)\.whatsapp\.net$/.test(trimmed)) return trimmed;
      return undefined;
    },

    looksLikeTarget(raw: string): boolean {
      const trimmed = raw.trim().replace(/^\+/, '');
      return /^\d{7,15}$/.test(trimmed) ||
        /^\d+@(g|s)\.whatsapp\.net$/.test(trimmed);
    },
  },

  webhook: {
    verifySignature(req: Request): boolean {
      const appSecret = process.env.WHATSAPP_APP_SECRET;
      if (!appSecret) return false;

      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) return false;

      try {
        const rawBody = typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
        const expected = 'sha256=' + crypto
          .createHmac('sha256', appSecret)
          .update(rawBody)
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
      try {
        const entry = body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        if (!value?.messages?.length) return null;

        const msg = value.messages[0];
        const contact = value.contacts?.[0];

        if (msg.type !== 'text' || !msg.text?.body) return null;

        return {
          platformUserId: msg.from,
          chatId: msg.from,
          text: msg.text.body,
          username: contact?.wa_id,
          displayName: contact?.profile?.name,
          replyToId: msg.context?.id,
        };
      } catch {
        return null;
      }
    },
  },
};
