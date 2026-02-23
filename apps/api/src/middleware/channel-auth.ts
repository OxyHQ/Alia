import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getChannel } from '../lib/channels/registry.js';
import type { ChannelId } from '../lib/channels/types.js';

declare global {
  namespace Express {
    interface Request {
      channelType?: ChannelId;
    }
  }
}

export function authenticateChannelBot(channelType: ChannelId) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const botSecret = req.headers['x-channel-bot-secret'] as string;

    if (!botSecret) {
      res.status(401).json({ error: 'Channel bot authentication required' });
      return;
    }

    const channel = getChannel(channelType);
    if (!channel) {
      res.status(401).json({ error: `Channel "${channelType}" not registered` });
      return;
    }

    const expectedSecret = channel.config.getBotSecret();
    if (!expectedSecret) {
      res.status(500).json({ error: `Bot secret not configured for ${channelType}` });
      return;
    }

    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    req.channelType = channelType;
    next();
  };
}
