import type { Request, RequestHandler, Response, NextFunction } from 'express';
import {
  createOxyAliaMachineCredentialAuth,
  type OxyAliaMachinePrincipal,
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyAuthRefusal,
  type OxyRequestUser,
  type OxyServiceAppContext,
  type OxyServiceActingAsContext,
} from '@oxy.so/core/server';
import { log } from '../lib/logger.js';
import { authenticateChannelAccount, hasChannelContext } from './channel-auth.js';
import { oxy, OXY_API_URL } from '../lib/oxy.js';
import {
  oxyInferenceEndpointRefusal,
  resolveOxyDeploymentEnvironment,
} from '../lib/inference/oxy-inference.js';

// Extend Express Request for Oxy users and service tokens
declare global {
  // biome-ignore lint/style/noNamespace: Express/global type augmentation requires `declare global { namespace Express }`.
  namespace Express {
    interface Request {
      userId?: string;
      /** The verified session's id, set by Oxy's user-token middleware with `userId`. */
      sessionId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      serviceApp?: OxyServiceAppContext;
      /** Present only after Oxy verified requester proof or an external delegation grant. */
      serviceActingAs?: OxyServiceActingAsContext;
      /** Oxy-verified app-only principal, never an owner mapped onto req.user. */
      machineCredential?: OxyAliaMachinePrincipal;
    }
  }
}

/**
 * What Alia writes down when Oxy refuses a credential.
 *
 * The SDK answers a fixed body and tells the caller nothing, which is right —
 * and on the optional path a refusal used to leave no trace at all: the request
 * arrived unauthenticated and the generic 401 was the whole story. Oxy served
 * `{"keys":[]}` from its JWKS with no signing key bound, every service token
 * failed, Alia logged nothing and Homiio saw a 401. `code` is stable and
 * greppable; nothing here reaches a response.
 */
const onOxyRefusal = ({ code, stage, reason, status, optional }: OxyAuthRefusal): void => {
  log.auth.warn({ code, stage, reason, status, optional }, 'Oxy refused a credential');
};

/**
 * Every lane is built ONCE, from the one `OxyServer` (`lib/oxy.ts`), whose
 * `expectedAudience` is Alia's own (`oxy-service:<ALIA_APPLICATION_ID>`).
 *
 * A user bearer is validated against Oxy; a service token is verified against
 * Oxy's public keys and its LIVE authority, and an `X-Oxy-User-Id` on it is
 * honoured only after Oxy confirms requester proof or an external delegation
 * grant. A process that cannot attest its own workload cannot ask either
 * question, and the SDK answers that as 503 (`SERVICE_AUTHORITY_UNAVAILABLE`):
 * an outage, never a refusal and never a pass.
 */
const authOptions = { auth: { onRefusal: onOxyRefusal } } as const;

/** Oxy authentication for a user bearer OR a service token, delegated or not. */
export const authenticateToken = createOxyAuthMiddleware(oxy, authOptions);

/** Optional Oxy auth: verifies a token when present (service tokens set `req.serviceApp`), never refuses. */
export const optionalAuth = createOptionalOxyAuth(oxy, authOptions);

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 *
 * Alia supplies no private verification secret: service tokens are verified
 * against Oxy's public `/.well-known/jwks.json` (issuer, audience, lifetime,
 * type and live authority), failing closed when the key set or exact `kid` is
 * unavailable. Never add `ACCESS_TOKEN_SECRET` or a private signing key here.
 *
 * `/internal/trigger` is a DELEGATED surface — it documents `X-Oxy-User-Id` and
 * refuses without a `req.userId`; the grant is Oxy's answer, never the header.
 */
export const oxyServiceAuth: RequestHandler = oxy.middleware.service({
  onRefusal: onOxyRefusal,
});

/**
 * The Oxy Console app-only lane (ADR 0010 §2), or `null` when this deployment's
 * Oxy origin is not one Alia may send that credential to.
 */
const machineCredentialAuth =
  oxyInferenceEndpointRefusal(OXY_API_URL, resolveOxyDeploymentEnvironment()) === null
    ? createOxyAliaMachineCredentialAuth(oxy, { environment: resolveOxyDeploymentEnvironment() })
    : null;

/**
 * Refuse a retired `alia_sk_*` key with a body that says so.
 *
 * Alia-issued developer keys were retired by the owner's clean cut: the
 * `developer_apps` / `developer_api_keys` tables are gone, so no such key can
 * authenticate anywhere. The refusal is explicit rather than an accident of the
 * Oxy SDK refusing a string that is not a JWT. Credentials for Alia's API come
 * from Oxy (ADR 0010); Alia issues and accepts none of its own.
 */
export function refuseRetiredAliaKey(res: Response): void {
  res.status(401).json({
    error: 'credential_retired',
    message:
      'Alia API keys (alia_sk_*) have been retired and are no longer accepted. Authenticate with Oxy.',
  });
}

/**
 * Accepts an Oxy user or service token, plus the Telegram and channel bot
 * secrets. The name keeps "API key" because this is where the Oxy Console
 * application-key lane lives (ADR 0010 §2). Only an explicitly scoped
 * machine principal can enter the two app-only chat routes; it is never a user.
 */
export function authenticateTokenOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const presented = req.headers.authorization;
  const rawMachine = presented?.startsWith('Bearer oxy_sk_') === true;
  if (rawMachine) {
    const path = req.originalUrl.split('?')[0];
    const turnCancellation = /^\/v1\/chat\/turns\/[0-9a-f-]{36}\/cancel$/i.test(path);
    if (
      req.method !== 'POST' ||
      (!['/alia/chat', '/v1/chat/completions'].includes(path) && !turnCancellation)
    ) {
      res.status(403).json({ error: 'MACHINE_PRODUCT_ROUTE_UNSUPPORTED' });
      return;
    }
    if (!machineCredentialAuth) {
      res.status(503).json({ error: 'MACHINE_CREDENTIAL_VERIFIER_UNAVAILABLE' });
      return;
    }
    // Canonical SDK verification uses Alia's own resource identity. No local
    // lookup, JWT decoding, credential persistence or owner-to-user conversion.
    void machineCredentialAuth(req, res, next);
    return;
  }
  // Already authenticated (e.g., by channel bot pre-middleware)
  if (req.user) {
    return next();
  }

  if (req.channelContext) return next();
  if (hasChannelContext(req)) {
    void authenticateChannelAccount(req, res, next);
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (token.startsWith('alia_sk_')) {
    refuseRetiredAliaKey(res);
    return;
  }

  // Existing Oxy user/service JWT paths remain separate from the app-only lane.
  authenticateToken(req, res, next);
}
