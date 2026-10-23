import { ALIA_SERVICE_AUDIENCE } from '@alia.onl/server';
import type { Request, Response, NextFunction } from 'express';
import {
  OxyServer,
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
import { oxyServiceClient } from '../lib/oxy-service-client.js';
import {
  oxyInferenceEndpointRefusal,
  resolveOxyDeploymentEnvironment,
} from '../lib/inference/oxy-inference.js';

// Initialize Oxy client
export const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
const OXY_API_REQUEST_TIMEOUT = (() => {
  try {
    const hostname = new URL(OXY_API_URL).hostname;
    // Local Oxy may be using the production database through a development
    // tunnel. Its session checks can exceed the SDK's 5s default under load.
    // Keep the longer deadline scoped to loopback so hosted deployments retain
    // the SDK default.
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
      ? 15_000
      : undefined;
  } catch {
    return undefined;
  }
})();
export const oxyClient = new OxyServer({
  baseURL: OXY_API_URL,
  requestTimeout: OXY_API_REQUEST_TIMEOUT,
});

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
      /** Present only after Oxy verified the app's delegation grant for X-Oxy-User-Id. */
      serviceActingAs?: OxyServiceActingAsContext;
      /** Oxy-verified app-only principal, never an owner mapped onto req.user. */
      machineCredential?: OxyAliaMachinePrincipal;
    }
  }
}

/**
 * Oxy authentication middleware (official @oxy.so/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
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

const oxyAuthOptions = {
  auth: { debug: true, onRefusal: onOxyRefusal, expectedAudience: ALIA_SERVICE_AUDIENCE },
} as const;

/** The same observer on the service-only lane, which `serviceAuth` forwards. */
const oxyServiceAuthOptions = {
  debug: true,
  onRefusal: onOxyRefusal,
  expectedAudience: ALIA_SERVICE_AUDIENCE,
} as const;

const userTokenAuth = createOxyAuthMiddleware(oxyClient, oxyAuthOptions);

/** Optional Oxy auth: verifies a token when present (service tokens set `req.serviceApp`), never refuses. */
const optionalUserTokenAuth = createOptionalOxyAuth(oxyClient, oxyAuthOptions);

/**
 * The header a service sets to say "I am acting for this person".
 *
 * Read as a constant so the delegation lane is chosen in ONE place. Nothing
 * here grants anything on the strength of it: the grant is Oxy's answer to
 * `GET /internal/service-acting-as/verify`, which the middleware below asks for
 * on every delegated request.
 */
const OXY_DELEGATED_USER_HEADER = 'x-oxy-user-id';

type AuthLane = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * A DELEGATED request needs a verifier that can prove who IT is.
 *
 * `@oxy.so/core` answers `X-Oxy-User-Id` by asking Oxy whether an explicit
 * `acting-as:offline` grant exists for `(appId, userId)` — and that endpoint is
 * service-to-service, so the SDK presents the VERIFIER's own service token to
 * reach it. `oxyClient` has no credential (it is the token-verifying client and
 * is correct without one), so `getServiceToken()` threw, the SDK logged
 * `Service credentials not provided`, cached a negative result for 60s and
 * answered `403 SERVICE_ACTING_AS_UNAUTHORIZED` — to a caller holding a
 * perfectly valid grant. Alia could never accept an offline delegation. The
 * production chat canary presents exactly this shape, and the C3 check in core
 * is right: a service may only act as a user with an explicit grant. The
 * missing piece was Alia's ability to ASK.
 *
 * So the lane is chosen per request: plain traffic keeps the credential-free
 * client, and a request that claims delegation is verified by Alia's own
 * credentialed client (`lib/oxy-service-client.ts`).
 *
 * Built lazily and rebuilt only if the credentialed client itself changes,
 * because `oxyServiceClient()` reads the environment on first use and caches
 * the minted service token on the INSTANCE. One instance per client keeps one
 * token cache and one JWKS cache.
 *
 * @param plain the lane for a request that claims no delegation
 * @param build the same lane, built against a credentialed verifier
 * @param whenUnverifiable `refuse` answers 503 rather than denying a valid
 *   grant with a misleading 403; `continue` is for the OPTIONAL lane, which may
 *   not invent a new way to fail.
 */
function delegationAware<Lane extends AuthLane>(
  plain: Lane,
  build: (verifier: OxyServer) => Lane,
  whenUnverifiable: 'refuse' | 'continue',
): Lane {
  let delegated: Lane | undefined;
  let builtFrom: OxyServer | undefined;

  const dispatch: AuthLane = (req, res, next) => {
    if (req.headers[OXY_DELEGATED_USER_HEADER] === undefined) {
      void plain(req, res, next);
      return;
    }

    const verifier = oxyServiceClient();
    if (!verifier) {
      // Only reachable in a process that never ran the boot guards: being able
      // to mint an Oxy service token — from a credential pair, or by attesting
      // the ECS task role (oxy ADR 0026) — is already required before the socket
      // opens (`lib/boot-guards.ts` → `unsetOxyInferenceCredentialVariables`),
      // and `lib/oxy-service-client.ts` builds this verifier from the same
      // capability. Answering 503 with a name is
      // still the point: the alternative is refusing every delegated user with
      // a 403 that says they have no grant, which is a lie about somebody
      // else's configuration.
      if (whenUnverifiable === 'refuse') {
        log.auth.error(
          { path: req.path },
          'Delegated request refused: Alia holds no Oxy service credential to check the acting-as grant with',
        );
        res.status(503).json({
          error: 'SERVICE_DELEGATION_UNAVAILABLE',
          code: 'delegation_unverifiable',
          message: 'Delegated requests cannot be verified by this deployment',
          status: 503,
        });
        return;
      }
      void plain(req, res, next);
      return;
    }

    if (builtFrom !== verifier) {
      delegated = build(verifier);
      builtFrom = verifier;
    }
    void (delegated as Lane)(req, res, next);
  };
  // The dispatcher IS whichever lane it wraps, and saying so keeps each mount's
  // own inference: Express reads `:planId` off the route only while every
  // handler on it still carries the SDK's exact middleware type.
  return dispatch as unknown as Lane;
}

/**
 * Oxy authentication for a user bearer OR a service token, delegated or not.
 *
 * A delegated service token is verified by the credentialed client; everything
 * else keeps the credential-free one.
 */
export const authenticateToken = delegationAware(
  userTokenAuth,
  (verifier) => createOxyAuthMiddleware(verifier, oxyAuthOptions),
  'refuse',
);

const oxyOptionalAuth = delegationAware(
  optionalUserTokenAuth,
  (verifier) => createOptionalOxyAuth(verifier, oxyAuthOptions),
  'continue',
);

/**
 * `@oxy.so/core` 4.4 types this middleware's `req.user` as its own `User`, while
 * this app's Express augmentation (above) says `OxyRequestUser`; both describe
 * the same object the middleware sets. Viewed as an `AuthLane` so the lanes
 * below compose; the runtime function is the SDK's, untouched.
 */
const asAuthLane = (lane: unknown): AuthLane => lane as AuthLane;

const serviceOnlyAuth = asAuthLane(oxyClient.middleware.service(oxyServiceAuthOptions));

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 *
 * Alia deliberately supplies no private verification secret. The compatible
 * `@oxy.so/core` release verifies Ed25519 service tokens against Oxy's public
 * `/.well-known/jwks.json`, including issuer, audience, lifetime, type and
 * scopes. The middleware fails closed when that endpoint or exact `kid` is not
 * available. Never add `ACCESS_TOKEN_SECRET` or a private signing key here.
 *
 * `/internal/trigger` is a DELEGATED surface — it documents `X-Oxy-User-Id` and
 * refuses without a `req.userId` — so it takes the same lane split as
 * `authenticateToken`: the acting-as grant is checked by a verifier that can
 * present its own service token.
 */
export const oxyServiceAuth = delegationAware(
  serviceOnlyAuth,
  (verifier) => asAuthLane(verifier.middleware.service(oxyServiceAuthOptions)),
  'refuse',
);

/**
 * Optional auth - attaches user if token present, doesn't block if absent
 * Tries bot auth first (Telegram), then Oxy JWT auth
 */

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Uses @oxy.so/core/server optional auth — attaches user if valid, continues if not.
  oxyOptionalAuth(req, res, next);
}

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
    if (req.method !== 'POST' || !['/alia/chat', '/v1/chat/completions'].includes(path)) {
      res.status(403).json({ error: 'MACHINE_PRODUCT_ROUTE_UNSUPPORTED' });
      return;
    }
    const environment = resolveOxyDeploymentEnvironment();
    const verifier = oxyServiceClient();
    if (!verifier || oxyInferenceEndpointRefusal(OXY_API_URL, environment) !== null) {
      res.status(503).json({ error: 'MACHINE_CREDENTIAL_VERIFIER_UNAVAILABLE' });
      return;
    }
    // Canonical SDK verification uses Alia's own resource identity. No local
    // lookup, JWT decoding, credential persistence or owner-to-user conversion.
    void createOxyAliaMachineCredentialAuth(verifier, { environment })(req, res, next);
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
