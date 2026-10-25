import type { VerifiedChannelContext } from '../types/channel-context.js';
import type { Request, Response, NextFunction } from 'express';
import {
  ALIA_SERVICE_AUDIENCE,
  ALIA_INTEGRATIONS_WORKLOAD_ID,
  ALIA_CHANNEL_HEADER,
  ALIA_PLATFORM_USER_HEADER,
  ALIA_CHANNEL_SESSION_HEADER,
  isAliaWorkload,
} from '@alia.onl/server/internal';
import { isLiveEntityId } from '@oxy.so/db';
import { oxyServiceClient } from '../lib/oxy-service-client.js';
import { getDb } from '../db/index.js';
import { findSystemBot, findBotUser } from '../db/integrations/botRepository.js';
import { findConnectedAccountBySession } from '../db/integrations/connectedAccountRepository.js';
import type { ChannelId } from '../lib/channels/types.js';

export function channelAccountOf(req: Request): string | undefined {
  return req.channelContext?.accountId;
}

/** Authenticate the exact integrations workload. Brand, headers and API keys confer no trust. */
async function requireIntegrations(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (
    req.headers['x-oxy-user-id'] !== undefined ||
    req.headers['x-oxy-requester-token'] !== undefined
  ) {
    res.status(403).json({ error: 'Channel identity must come from its provider link' });
    return;
  }
  const oxy = oxyServiceClient();
  if (!oxy) {
    res.status(503).json({ error: 'Integrations verifier unavailable' });
    return;
  }
  await oxy.middleware.service({ expectedAudience: ALIA_SERVICE_AUDIENCE })(req, res, () => {
    const principal = req.serviceApp;
    if (
      !isAliaWorkload(
        principal && { ...principal, applicationId: principal.appId },
        process.env.ALIA_INTEGRATIONS_WORKLOAD_ID || ALIA_INTEGRATIONS_WORKLOAD_ID,
      )
    ) {
      res.status(403).json({ error: 'Integrations workload required' });
      return;
    }
    // The shared service verifier stores the incoming workload bearer. It is
    // never the local channel account's foreground session credential.
    delete req.accessToken;
    next();
  });
}

/** Administrative bot endpoints are private to the integrations process. */
export function authenticateChannelBot(channelType: ChannelId) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireIntegrations(req, res, () => {
      if (req.headers[ALIA_CHANNEL_HEADER] !== channelType) {
        res.status(403).json({ error: 'Channel mismatch' });
        return;
      }
      req.channelType = channelType;
      next();
    });
  };
}

export function hasChannelContext(req: Request): boolean {
  return req.headers[ALIA_CHANNEL_HEADER] !== undefined;
}

/** Resolve the account from the live provider link, never from an account header.
 * A channel context is local product authority; it is not an Oxy user session. */
export async function authenticateChannelAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireIntegrations(req, res, () => {
    void resolveChannelAccount(req, res, next);
  });
}

async function resolveChannelAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const platform = req.headers[ALIA_CHANNEL_HEADER];
    const platformUserId = req.headers[ALIA_PLATFORM_USER_HEADER];
    const sessionId = req.headers[ALIA_CHANNEL_SESSION_HEADER];
    if (typeof platform !== 'string' || (platformUserId !== undefined && sessionId !== undefined)) {
      res.status(401).json({ error: 'Channel context required' });
      return;
    }
    let context: VerifiedChannelContext | undefined;
    if (
      ['telegram', 'discord'].includes(platform) &&
      typeof platformUserId === 'string' &&
      platformUserId.length > 0
    ) {
      const bot = await findSystemBot(getDb(), platform);
      const link =
        bot?.status === 'active' ? await findBotUser(getDb(), bot.id, platformUserId) : null;
      if (link?.isLinked && link.oxyUserId && isLiveEntityId(link.oxyUserId)) {
        context = {
          kind: 'bot',
          accountId: link.oxyUserId,
          platform,
          identityId: link.id,
          ...(link.oxyTaskState === 'active' && link.oxyTaskId ? { taskId: link.oxyTaskId } : {}),
        };
      }
    } else if (
      ['whatsapp', 'signal', 'telegram-gateway'].includes(platform) &&
      typeof sessionId === 'string' &&
      sessionId.length > 0
    ) {
      const connection = await findConnectedAccountBySession(
        getDb(),
        platform === 'telegram-gateway' ? 'telegram' : platform,
        sessionId,
      );
      if (connection && isLiveEntityId(connection.oxyUserId)) {
        context = {
          kind: 'account',
          accountId: connection.oxyUserId,
          platform,
          identityId: connection.id,
          ...(connection.oxyTaskState === 'active' && connection.oxyTaskId
            ? { taskId: connection.oxyTaskId }
            : {}),
        };
      }
    }
    if (!context) {
      res.status(401).json({ error: 'Channel account is not linked' });
      return;
    }
    req.channelContext = context;
    req.userId = context.accountId;
    // No req.user, sessionId or accessToken: remote messages cannot impersonate a foreground requester.
    next();
  } catch {
    res.status(503).json({ error: 'Channel account unavailable' });
  }
}
