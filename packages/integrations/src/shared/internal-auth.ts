import type { Request, Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxy.so/db';
import {
  ALIA_SERVICE_AUDIENCE,
  ALIA_API_WORKLOAD_ID,
  ALIA_ACCOUNT_CONTEXT_HEADER,
  isAliaWorkload,
} from '@alia.onl/server/internal';
import { oxy } from './oxy';
import { verifySecret } from '@oxy.so/core/server';
import { authorizeUpgrade } from '../realtime/subscription-auth';

const verifiedRequests = new WeakSet<object>();
export const isWorkloadRequest = (req: object): boolean => verifiedRequests.has(req);

const serviceAuth = oxy.middleware.service({ expectedAudience: ALIA_SERVICE_AUDIENCE });
const expectedWorkload = () => process.env.ALIA_API_WORKLOAD_ID || ALIA_API_WORKLOAD_ID;

/** Same-product process authentication. This never fabricates an Oxy user session. */
export async function requireAliaApi(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Finite reader transition: only a request with NO Authorization may use
  // the pre-existing gateway-secret protocol. Invalid new credentials never downgrade.
  if (req.headers.authorization === undefined) {
    const presented = req.headers['x-gateway-secret'];
    const expected = process.env.INTEGRATIONS_SECRET;
    if (typeof presented !== 'string' || !expected || !verifySecret(presented, expected)) {
      res.status(401).json({ error: 'Invalid gateway secret' });
      return;
    }
    next();
    return;
  }
  if (
    ['x-oxy-user-id', 'x-oxy-requester-token', 'x-oxy-task-id'].some(
      (key) => req.headers[key] !== undefined,
    )
  ) {
    res.status(403).json({ error: 'Use internal account context for Alia operations' });
    return;
  }
  await serviceAuth(req, res, () => {
    const principal = (
      req as Request & { serviceApp?: { authority?: string; appId: string; credentialId: string } }
    ).serviceApp;
    if (
      !isAliaWorkload(
        principal && { ...principal, applicationId: principal.appId },
        expectedWorkload(),
      )
    ) {
      res.status(403).json({ error: 'Alia API workload required' });
      return;
    }
    verifiedRequests.add(req);
    next();
  });
}

export function internalAccount(req: Pick<Request, 'headers'>): string | undefined {
  if (!isWorkloadRequest(req)) return undefined;
  const value = req.headers[ALIA_ACCOUNT_CONTEXT_HEADER];
  return typeof value === 'string' && isLiveEntityId(value) ? value : undefined;
}

export function requireAccountContext(req: Request, res: Response, next: NextFunction): void {
  if (!isWorkloadRequest(req)) {
    next();
    return;
  }
  if (!internalAccount(req)) {
    res.status(401).json({ error: 'Internal account context required' });
    return;
  }
  next();
}

/** Shared Oxy introspection verifies live signature, audience, registry and revocation for upgrades. */
export async function authorizeInternalUpgrade(
  headers: Request['headers'],
): Promise<string | null> {
  const authorization = headers.authorization;
  if (headers.authorization === undefined) {
    const verdict = authorizeUpgrade(headers, process.env.INTEGRATIONS_SECRET || '', verifySecret);
    return verdict.ok ? verdict.userId : null;
  }
  if (headers['x-oxy-user-id'] !== undefined || headers['x-oxy-requester-token'] !== undefined)
    return null;
  const context = headers[ALIA_ACCOUNT_CONTEXT_HEADER];
  const accountId = typeof context === 'string' && isLiveEntityId(context) ? context : undefined;
  if (!accountId || typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
    return null;
  try {
    const principal = await oxy.introspectServiceToken(authorization.slice(7));
    return principal.active &&
      principal.audience === ALIA_SERVICE_AUDIENCE &&
      isAliaWorkload(principal, expectedWorkload())
      ? accountId
      : null;
  } catch {
    return null;
  }
}
