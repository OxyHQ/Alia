/**
 * Foreground Syra calls retain the middleware-verified human session. Each
 * operation owns a linked SDK client and closes it deterministically; this
 * server has no refresh secret and never turns a workload into a human session.
 * Workers redeem the existing single-use episode ticket without a user bearer.
 */
import { OxyServer } from '@oxy.so/core/server';
import { createSyraClient, syraForOxySession, type SyraClient } from '@syra.fm/sdk';
import type { Request } from 'express';

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
  const oxy = new OxyServer({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  oxy.session.setAccessToken(req.accessToken);
  // The original browser/native device owns refresh. An expired/revoked
  // forwarded session fails; no server-issued replacement or owner fallback.
  oxy.http.setAuthRefreshHandler(async () => null);
  try {
    const syra = syraForOxySession(oxy, { baseURL: SYRA_API_URL });
    try {
      return await operation(syra);
    } finally {
      syra.dispose();
    }
  } finally {
    oxy.dispose();
  }
}

/** Ingest/abandon authenticate only with the operation's single-use ticket. */
export function syraForTicket(): SyraClient {
  return createSyraClient({ baseURL: SYRA_API_URL });
}
