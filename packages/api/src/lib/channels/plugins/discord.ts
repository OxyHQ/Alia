import crypto from 'crypto';
import type { ChannelPlugin, OutboundContext, OutboundResult, ChannelInboundMessage } from '../types.js';
import type { Request } from 'express';
import { getErrorMessage } from '../../errors/index.js';

interface DiscordMessageResponse {
  id?: string;
}

export const discordPlugin: ChannelPlugin = {
  id: 'discord',

  meta: {
    id: 'discord',
    name: 'Discord',
    icon: 'discord',
    color: '#5865F2',
    textChunkLimit: 2000,
    supportsMedia: true,
    supportsThreads: true,
    supportsReactions: true,
  },

  config: {
    isConfigured: () =>
      !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_SECRET),
    getBotSecret: () => process.env.DISCORD_BOT_SECRET,
    getEnvPrefix: () => 'DISCORD',
  },

  outbound: {
    deliveryMode: 'direct',

    async sendText(ctx: OutboundContext): Promise<OutboundResult> {
      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) {
        return { channel: 'discord', ok: false, error: 'DISCORD_BOT_TOKEN not configured' };
      }

      try {
        const res = await fetch(`https://discord.com/api/v10/channels/${ctx.to}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: ctx.text,
            ...(ctx.replyToId && {
              message_reference: { message_id: ctx.replyToId },
            }),
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { channel: 'discord', ok: false, error: `Discord API ${res.status}: ${body}` };
        }

        const data = await res.json() as DiscordMessageResponse;
        return { channel: 'discord', ok: true, messageId: data.id };
      } catch (err: unknown) {
        return { channel: 'discord', ok: false, error: getErrorMessage(err) };
      }
    },
  },

  normalize: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim();
      if (/^\d{17,20}$/.test(trimmed)) return trimmed;
      const mentionMatch = trimmed.match(/^<[@#]!?(\d{17,20})>$/);
      if (mentionMatch) return mentionMatch[1];
      const channelMatch = trimmed.match(/^channel:(\d{17,20})$/);
      if (channelMatch) return channelMatch[1];
      return undefined;
    },

    looksLikeTarget(raw: string): boolean {
      const trimmed = raw.trim();
      return /^\d{17,20}$/.test(trimmed) ||
        /^<[@#]!?\d{17,20}>$/.test(trimmed) ||
        /^channel:\d{17,20}$/.test(trimmed);
    },
  },

  webhook: {
    verifySignature(req: Request): boolean {
      const signature = req.headers['x-signature-ed25519'] as string;
      const timestamp = req.headers['x-signature-timestamp'] as string;
      const publicKey = process.env.DISCORD_PUBLIC_KEY;

      if (!signature || !timestamp || !publicKey) return false;

      try {
        const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const message = Buffer.from(timestamp + body);
        const sig = Buffer.from(signature, 'hex');
        const key = Buffer.from(publicKey, 'hex');
        return crypto.verify(undefined, message, { key: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' }) }, sig);
      } catch {
        return false;
      }
    },

    parseMessage(body: any): ChannelInboundMessage | null {
      if (body.type !== 0 && body.type !== undefined) return null;

      const data = body.d ?? body;
      if (!data.content && !data.embeds?.length) return null;

      const author = data.author;
      if (!author?.id) return null;
      if (author.bot) return null;

      return {
        platformUserId: author.id,
        chatId: data.channel_id,
        text: data.content || '',
        username: author.username,
        displayName: author.global_name || author.username,
        replyToId: data.message_reference?.message_id,
        threadId: data.thread?.id,
        attachments: data.attachments?.map((a: any) => ({
          type: a.content_type || 'file',
          url: a.url,
        })),
      };
    },
  },
};
