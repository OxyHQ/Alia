import type { ChannelId } from '../lib/channels/types.js';

export interface VerifiedChannelContext {
  kind: 'bot' | 'account';
  accountId: string;
  platform: string;
  identityId: string;
  taskId?: string;
}

declare global {
  // biome-ignore lint/style/noNamespace: Express request augmentation.
  namespace Express {
    interface Request {
      channelType?: ChannelId;
      channelContext?: VerifiedChannelContext;
    }
  }
}
