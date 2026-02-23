import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';

export const signalPlugin: ChannelPlugin = {
  id: 'signal',

  meta: {
    id: 'signal',
    name: 'Signal',
    icon: 'signal',
    color: '#3A76F0',
    textChunkLimit: 4000,
    supportsMedia: true,
    supportsThreads: false,
    supportsReactions: true,
  },

  config: {
    isConfigured: () =>
      !!(process.env.SIGNAL_CLI_URL && process.env.SIGNAL_PHONE_NUMBER),
    getBotSecret: () => process.env.SIGNAL_BOT_SECRET,
    getEnvPrefix: () => 'SIGNAL',
  },

  outbound: {
    deliveryMode: 'direct',

    async sendText(ctx: OutboundContext): Promise<OutboundResult> {
      const signalUrl = process.env.SIGNAL_CLI_URL;
      const senderNumber = process.env.SIGNAL_PHONE_NUMBER;

      if (!signalUrl || !senderNumber) {
        return { channel: 'signal', ok: false, error: 'Signal credentials not configured' };
      }

      try {
        const payload: Record<string, any> = {
          message: ctx.text,
          number: senderNumber,
          recipients: [ctx.to],
        };

        const res = await fetch(`${signalUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const body = await res.text();
          return { channel: 'signal', ok: false, error: `Signal API ${res.status}: ${body}` };
        }

        const data = await res.json() as any;
        return { channel: 'signal', ok: true, messageId: data.timestamp?.toString() };
      } catch (err: any) {
        return { channel: 'signal', ok: false, error: err.message };
      }
    },
  },

  normalize: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim();
      const phone = trimmed.replace(/^\+/, '');
      if (/^\d{7,15}$/.test(phone)) return '+' + phone;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return trimmed;
      }
      try {
        const decoded = Buffer.from(trimmed, 'base64');
        if (decoded.length > 0 && decoded.toString('base64') === trimmed) {
          return trimmed;
        }
      } catch { /* not base64 */ }
      return undefined;
    },

    looksLikeTarget(raw: string): boolean {
      const trimmed = raw.trim();
      const phone = trimmed.replace(/^\+/, '');
      if (/^\d{7,15}$/.test(phone)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return true;
      }
      try {
        const decoded = Buffer.from(trimmed, 'base64');
        if (decoded.length > 0 && decoded.toString('base64') === trimmed) return true;
      } catch { /* not base64 */ }
      return false;
    },
  },

  webhook: {
    verifySignature(_req: Request): boolean {
      return true;
    },

    parseMessage(body: any): ChannelInboundMessage | null {
      try {
        const envelope = body.envelope ?? body;
        const dataMessage = envelope.dataMessage;
        if (!dataMessage?.message) return null;

        const source = envelope.source ?? envelope.sourceNumber;
        if (!source) return null;

        return {
          platformUserId: source,
          chatId: envelope.sourceUuid ?? source,
          text: dataMessage.message,
          displayName: envelope.sourceName,
          attachments: dataMessage.attachments?.map((a: any) => ({
            type: a.contentType || 'file',
            url: a.id || a.filename || '',
          })),
        };
      } catch {
        return null;
      }
    },
  },
};
