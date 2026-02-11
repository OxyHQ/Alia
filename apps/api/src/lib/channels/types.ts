import type { Request } from 'express';

export type ChannelId = 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'signal';

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  icon: string;
  color: string;
  textChunkLimit: number;
  supportsMedia: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
}

export interface ChannelPlugin {
  id: ChannelId;
  meta: ChannelMeta;
  config: ChannelConfigAdapter;
  outbound: ChannelOutboundAdapter;
  security?: ChannelSecurityAdapter;
  normalize: ChannelNormalizeAdapter;
  webhook?: ChannelWebhookAdapter;
}

export interface ChannelConfigAdapter {
  isConfigured: () => boolean;
  getBotSecret: () => string | undefined;
  getEnvPrefix: () => string;
}

export interface ChannelOutboundAdapter {
  deliveryMode: 'direct' | 'gateway';
  sendText: (ctx: OutboundContext) => Promise<OutboundResult>;
  sendMedia?: (ctx: OutboundContext) => Promise<OutboundResult>;
  chunker?: (text: string, limit: number) => string[];
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  metadata?: Record<string, any>;
}

export interface OutboundResult {
  channel: ChannelId;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelSecurityAdapter {
  resolveDmPolicy: (accountId: string) => DmPolicy;
}

export interface DmPolicy {
  policy: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allowFrom?: string[];
}

export interface ChannelNormalizeAdapter {
  normalizeTarget: (raw: string) => string | undefined;
  looksLikeTarget: (raw: string) => boolean;
}

export interface ChannelWebhookAdapter {
  verifySignature: (req: Request) => boolean;
  parseMessage: (body: any) => ChannelInboundMessage | null;
}

export interface ChannelInboundMessage {
  channelUserId: string;
  chatId: string;
  text: string;
  username?: string;
  displayName?: string;
  replyToId?: string;
  threadId?: string;
  attachments?: { type: string; url: string }[];
}
