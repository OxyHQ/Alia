/**
 * Foreground Syra calls retain the middleware-verified human session: each
 * operation runs on `oxy.withUser(req)` — a client bound to exactly that
 * bearer, never refreshed (the person's own device owns refresh, so an expired
 * or revoked session fails) and disposed when the operation settles. This
 * server never turns a workload into a human session. Workers redeem the
 * existing single-use episode ticket without a user bearer.
 */
import { createSyraClient, syraForOxySession, type SyraClient } from '@syra.fm/sdk';
import type { Request } from 'express';
import { oxy } from '../oxy.js';

const SYRA_API_URL = process.env.SYRA_API_URL?.trim() || 'https://api.syra.fm';

export async function withSyraRequest<T>(
  req: Request,
  operation: (client: SyraClient) => Promise<T>,
): Promise<T> {
  if (
    !req.accessToken ||
    !req.sessionId ||
    !req.user?.id ||
    req.userId !== req.user.id ||
    req.serviceApp ||
    req.machineCredential ||
    req.channelContext
  ) {
    throw new Error('Syra requires a verified human session');
  }
  return oxy.withUser(req, async (user) => {
    const syra = syraForOxySession(user, { baseURL: SYRA_API_URL });
    try {
      return await operation(syra);
    } finally {
      syra.dispose();
    }
  });
}

/** Ingest/abandon authenticate only with the operation's single-use ticket. */
export function syraForTicket(): SyraClient {
  return createSyraClient({ baseURL: SYRA_API_URL });
}
