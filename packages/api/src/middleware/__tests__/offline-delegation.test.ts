import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ALIA_SERVICE_AUDIENCE } from '@alia.onl/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Real shared service middleware verifies caller signatures and asks Oxy for
 * live authority. The receiving Alia workload presents protocol v2 for both
 * service introspection and external offline-delegation checks.
 */

/**
 * The REAL `@oxy.so/core/server`, not the pass-through stub `vitest.config.ts`
 * aliases it to.
 *
 * That alias exists so routers can be mounted without standing up
 * authentication, and it stubs `createOxyAuthMiddleware` to `next()` — which is
 * exactly the decision under test here. Reached through Node's resolver for the
 * same reason `src/__tests__/mocks/oxy-core-server.ts` reaches `createOxyCors`
 * that way: Vite rewrites the specifier in any `import`, alias included, so the
 * way back to the package is the resolver that knows nothing about the alias.
 */
vi.mock('@oxy.so/core/server', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('@oxy.so/core/server') as Record<string, unknown>;
});

const serviceClient = vi.hoisted(() => ({ current: null as unknown }));

// The one Oxy client (`lib/oxy.ts`), forwarded to the verifier each case
// builds: these cases drive the delegation lane against a controlled Oxy.
vi.mock('../../lib/oxy.js', async () => {
  const { forwardingOxy } = await import('../../__tests__/mocks/oxy-user-client.js');
  return { oxy: forwardingOxy(() => serviceClient.current), OXY_API_URL: 'https://api.oxy.so' };
});
vi.mock('../../lib/logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: () => [] }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/telemetry/apiKeyUsageRepository.js', () => ({ recordApiKeyUsage: vi.fn() }));

const OXY_BASE_URL = 'https://api.oxy.test';
process.env.OXY_API_URL = OXY_BASE_URL;

const { OxyServer } = await import('@oxy.so/core/server');
const { authenticateToken, oxyServiceAuth } = await import('../auth.js');

const KEY = generateKeyPairSync('ed25519');
const KID = 'oxy-service-2026-09';
const APP = 'homiio-application-id';
const USER = '6981c9178fcdefaf81988ffb';
let mint: (exchange: Record<string, unknown>) => string;

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

/** A real Ed25519 Oxy service token — the middleware verifies this signature. */
function serviceToken(
  claims: Record<string, unknown> = {},
  privateKey: KeyObject = KEY.privateKey,
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: KID };
  const payload = {
    type: 'service',
    appId: APP,
    appName: 'Homiio',
    credentialId: 'homiio-credential-id',
    ownerAccountId: 'homiio-owner-account',
    environment: 'production',
    scopes: ['acting-as:offline', 'inference:invoke'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + 300,
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(signBytes(null, Buffer.from(signingInput), privateKey))}`;
}

/** Shared SDK verifier; only Oxy's network endpoints are fixtures. */
function credentialedVerifier(
  grant: { authorized: boolean; scopes?: string[] } | 'unreachable',
  active = true,
) {
  // As `lib/oxy.ts` builds it: Alia's own audience, its workload identity.
  const oxy = new OxyServer({
    baseURL: OXY_BASE_URL,
    expectedAudience: ALIA_SERVICE_AUDIENCE,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'fixture',
    }),
  });
  const ownToken = serviceToken({
    authority: 'first_party',
    tier: 'internal',
    appId: 'alia',
    credentialId: 'wl_alia',
    scopes: undefined,
  });
  const getServiceToken = vi.fn((exchange: Record<string, unknown>) => {
    expect(exchange).toMatchObject({ protocolVersion: 2 });
    expect(exchange.audience ?? 'oxy-api').toBe('oxy-api');
    expect(exchange.scopes).toBeUndefined();
    return ownToken;
  });
  mint = getServiceToken;
  const makeRequest = vi.fn(async (_method: string, path: string, data: Record<string, string>) => {
    if (path === '/auth/resources/introspect') {
      if (!active) return { active: false };
      const claims = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString());
      return {
        active: true,
        authority: claims.authority ?? 'external',
        applicationId: claims.appId,
        credentialId: claims.credentialId,
        accountId: claims.ownerAccountId,
        environment: claims.environment,
        audience: claims.aud,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        ...(claims.authority === 'first_party' ? {} : { scopes: claims.scopes }),
      };
    }
    if (path !== '/internal/service-acting-as/verify')
      throw new Error(`unexpected request: ${path}`);
    if (grant === 'unreachable') throw new Error('verify endpoint unreachable');
    return { ...grant, scopes: grant.scopes ?? [], epoch: '1' };
  });
  vi.spyOn(oxy, 'request').mockImplementation(makeRequest as never);
  return { oxy, getServiceToken, makeRequest, ownToken };
}

let server: http.Server;
const fetchReal = globalThis.fetch;

beforeAll(async () => {
  const jwk = { ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'EdDSA' };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input) === `${OXY_BASE_URL}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    if (String(input).endsWith('/auth/service-token/workload/challenge'))
      return Response.json({ nonce: 'fixture' });
    if (String(input).endsWith('/auth/service-token/workload'))
      return Response.json({ token: mint(JSON.parse(String(init?.body))), expiresIn: 300 });
    return fetchReal(input, init);
  });

  const app = express();
  app.use(express.json());
  app.post('/delegated', authenticateToken, (req, res) => {
    res.json({
      userId: req.userId ?? null,
      actingAs: req.serviceActingAs ?? null,
      appId: req.serviceApp?.appId ?? null,
    });
  });
  app.post('/internal/trigger', oxyServiceAuth, (req, res) => {
    res.json({ userId: req.userId ?? null, actingAs: req.serviceActingAs ?? null });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  serviceClient.current = null;
});

afterEach(() => {
  if (serviceClient.current instanceof OxyServer) serviceClient.current.dispose();
  vi.restoreAllMocks();
});

async function send(path: string, headers: Record<string, string>) {
  const { port } = server.address() as AddressInfo;
  const response = await fetchReal(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a delegated service request is verified by a credentialed client', () => {
  it("accepts a valid acting-as grant, and presents ALIA's own token to check it", async () => {
    const verifier = credentialedVerifier({ authorized: true, scopes: ['inference:invoke'] });
    serviceClient.current = verifier.oxy;

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      userId: USER,
      actingAs: { userId: USER, scopes: ['inference:invoke'] },
      appId: APP,
    });
    // The grant check went out as Alia, not as the caller and not anonymously.
    expect(verifier.getServiceToken).toHaveBeenCalled();
    expect(verifier.makeRequest).toHaveBeenCalledWith(
      'GET',
      '/internal/service-acting-as/verify',
      {
        appId: APP,
        userId: USER,
        credentialId: 'homiio-credential-id',
        ownerAccountId: 'homiio-owner-account',
        environment: 'production',
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${verifier.ownToken}` }),
        cache: false,
        retry: false,
        timeout: 5000,
      }),
    );
  });

  it('refuses a user the app holds no grant for — 403, C3 intact', async () => {
    const verifier = credentialedVerifier({ authorized: false });
    serviceClient.current = verifier.oxy;

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('SERVICE_ACTING_AS_UNAUTHORIZED');
    expect(verifier.makeRequest).toHaveBeenCalled();
  });

  it('refuses when the grant check itself fails, rather than admitting the user', async () => {
    serviceClient.current = credentialedVerifier('unreachable').oxy;

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('SERVICE_ACTING_AS_UNAUTHORIZED');
  });

  it('answers 503 when this process cannot ask Oxy at all — an outage, never a refusal', async () => {
    // A process whose workload cannot attest: it cannot ask Oxy whether the
    // calling service is live, let alone whether it holds a grant.
    serviceClient.current = new OxyServer({
      baseURL: OXY_BASE_URL,
      expectedAudience: ALIA_SERVICE_AUDIENCE,
      workloadCredentials: async () => {
        throw new Error('no task role on this machine');
      },
    });

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    // 503, not a 403 that blames the caller's grant for Alia's own missing
    // identity, and not a pass.
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('SERVICE_AUTHORITY_UNAVAILABLE');
  });

  it('checks live service authority even without a delegated user', async () => {
    serviceClient.current = credentialedVerifier({ authorized: true }).oxy;

    const result = await send('/delegated', { authorization: `Bearer ${serviceToken()}` });

    // No delegated user, so no user id: a service acting as itself is not a
    // person, and `requireOxyAuth` refuses the route.
    expect(result.status).toBe(401);
    expect(mint).toHaveBeenCalledOnce();
  });

  it('still refuses a service token whose signature does not verify', async () => {
    const impostor = generateKeyPairSync('ed25519');
    serviceClient.current = credentialedVerifier({ authorized: true }).oxy;

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken({}, impostor.privateKey)}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(401);
  });
});

describe('/internal, which documents the same delegation header', () => {
  it('accepts a live own service without treating its owner as a requester', async () => {
    const verifier = credentialedVerifier({ authorized: false });
    serviceClient.current = verifier.oxy;
    const result = await send('/internal/trigger', {
      authorization: `Bearer ${serviceToken({ authority: 'first_party', tier: 'internal', aud: ALIA_SERVICE_AUDIENCE, scopes: undefined, credentialId: 'wl_homiio' })}`,
    });
    expect(result).toEqual({ status: 200, body: { userId: null, actingAs: null } });
    expect(verifier.getServiceToken).toHaveBeenCalledOnce();
    expect(verifier.makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/resources/introspect',
      expect.any(Object),
      expect.any(Object),
    );
    expect(
      verifier.makeRequest.mock.calls.some(
        ([, path]) => path === '/internal/service-acting-as/verify',
      ),
    ).toBe(false);
  });

  it('refuses an own service revoked by the live authority lookup', async () => {
    const verifier = credentialedVerifier({ authorized: true }, false);
    serviceClient.current = verifier.oxy;
    const result = await send('/internal/trigger', {
      authorization: `Bearer ${serviceToken({ authority: 'first_party', tier: 'internal', aud: ALIA_SERVICE_AUDIENCE, scopes: undefined, credentialId: 'wl_homiio' })}`,
    });
    expect(result.status).toBe(401);
    expect(verifier.makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/resources/introspect',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('admits a granted delegated trigger', async () => {
    const verifier = credentialedVerifier({ authorized: true, scopes: ['triggers:write'] });
    serviceClient.current = verifier.oxy;

    const result = await send('/internal/trigger', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      userId: USER,
      actingAs: { userId: USER, scopes: ['triggers:write'] },
    });
  });

  it('refuses an ungranted one', async () => {
    serviceClient.current = credentialedVerifier({ authorized: false }).oxy;

    const result = await send('/internal/trigger', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    expect(result.status).toBe(403);
  });
});
