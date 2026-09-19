import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Offline delegation: a service token plus `X-Oxy-User-Id`, through the REAL
 * `@oxy.so/core` middleware.
 *
 * ## The defect these lock in
 *
 * `authenticateToken` was built from `oxyClient`, which carries NO service
 * credential — correct for verifying inbound user tokens and fatal for
 * delegation. `@oxy.so/core` answers `X-Oxy-User-Id` by asking Oxy whether an
 * explicit `acting-as:offline` grant exists, and that endpoint is
 * service-to-service: the SDK must present the VERIFIER's own service token to
 * reach it. With no credential, `getServiceToken()` threw, the SDK logged
 * `Service credentials not provided`, cached a negative result for 60 seconds
 * and answered `403 SERVICE_ACTING_AS_UNAUTHORIZED` — to a caller holding a
 * perfectly valid grant. Alia could never accept an offline delegation, and the
 * production chat canary presents exactly this shape.
 *
 * ## What is NOT being relaxed
 *
 * The C3 check in core stands: a service may act as a user only with an
 * explicit grant. The last cases below are the proof — an unauthorized answer
 * is still a 403, and a verifier that cannot ask says so with a 503 rather than
 * denying everyone with a 403 that blames the caller's grant.
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

// PARTIAL: `oxyServiceClient` is replaced because these cases drive the
// delegation lane against a controlled verifier, but `canAuthenticateAsOxyService`
// stays REAL — the last describe in this file asserts that it and the boot guard
// answer the same question, and a stub would make that agreement vacuous.
vi.mock('../../lib/oxy-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oxy-service-client.js')>()),
  oxyServiceClient: () => serviceClient.current,
}));
vi.mock('../../lib/logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: () => [] }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/developers/developerRepository.js', () => ({
  findKeyByHash: vi.fn(),
  findAppById: vi.fn(),
  touchKeyLastUsed: vi.fn(),
}));
vi.mock('../../db/telemetry/apiKeyUsageRepository.js', () => ({ recordApiKeyUsage: vi.fn() }));

const OXY_BASE_URL = 'https://api.oxy.test';
process.env.OXY_API_URL = OXY_BASE_URL;

const { OxyServices } = await import('@oxy.so/core');
const { authenticateToken, oxyServiceAuth, oxyClient } = await import('../auth.js');

const KEY = generateKeyPairSync('ed25519');
const KID = 'oxy-service-2026-09';
const APP = 'homiio-application-id';
const USER = '6981c9178fcdefaf81988ffb';

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

/** A real Ed25519 Oxy service token — the middleware verifies this signature. */
function serviceToken(claims: Record<string, unknown> = {}, privateKey: KeyObject = KEY.privateKey): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: KID };
  const payload = {
    type: 'service',
    appId: APP,
    appName: 'Homiio',
    credentialId: 'homiio-credential-id',
    ownerAccountId: 'homiio-owner-account',
    environment: 'production',
    scopes: ['inference:invoke'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + 3_600,
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(signBytes(null, Buffer.from(signingInput), privateKey))}`;
}

/**
 * Alia's own credentialed Oxy client, as `lib/oxy-service-client.ts` builds it.
 *
 * A REAL `OxyServices` with real credentials configured: only the two network
 * calls are stubbed, so the delegation check under test is core's own, not a
 * double of it.
 */
function credentialedVerifier(grant: { authorized: boolean; scopes?: string[] } | 'unreachable') {
  const oxy = new OxyServices({ baseURL: OXY_BASE_URL });
  oxy.configureServiceAuth('oxy_dk_alia_test', 'alia-secret');
  const getServiceToken = vi.fn().mockResolvedValue('alia-own-service-token');
  const makeRequest = vi.fn(async (_method: string, path: string) => {
    if (path !== '/internal/service-acting-as/verify') throw new Error(`unexpected request: ${path}`);
    if (grant === 'unreachable') throw new Error('verify endpoint unreachable');
    return grant;
  });
  vi.spyOn(oxy, 'getServiceToken').mockImplementation(getServiceToken as never);
  vi.spyOn(oxy, 'makeRequest').mockImplementation(makeRequest as never);
  return { oxy, getServiceToken, makeRequest };
}

let server: http.Server;
const fetchReal = globalThis.fetch;

beforeAll(async () => {
  const jwk = { ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'EdDSA' };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input) === `${OXY_BASE_URL}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
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
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  serviceClient.current = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function send(path: string, headers: Record<string, string>) {
  const { port } = server.address() as AddressInfo;
  const response = await fetchReal(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('a delegated service request is verified by a credentialed client', () => {
  it('accepts a valid acting-as grant, and presents ALIA\'s own token to check it', async () => {
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
      { appId: APP, userId: USER },
      expect.objectContaining({
        headers: { Authorization: 'Bearer alia-own-service-token' },
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

  it('never routes a delegated request through the credential-free verifier', async () => {
    const verifier = credentialedVerifier({ authorized: true, scopes: [] });
    serviceClient.current = verifier.oxy;
    const blindGrantCheck = vi.spyOn(oxyClient, 'verifyServiceActingAs');

    expect((await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    })).status).toBe(200);

    // The exact defect: `oxyClient` cannot ask, so anything it is asked to
    // verify is denied. It must not be asked.
    expect(blindGrantCheck).not.toHaveBeenCalled();
  });

  it('says so loudly when this deployment cannot check a grant at all', async () => {
    serviceClient.current = null;

    const result = await send('/delegated', {
      authorization: `Bearer ${serviceToken()}`,
      'x-oxy-user-id': USER,
    });

    // 503, not a 403 that blames the caller's grant for Alia's own missing
    // identity. Being able to mint an Oxy service token — from a credential pair
    // or from an attested task role — is a boot-guard requirement, so a
    // deployment that serves at all never takes this branch.
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('SERVICE_DELEGATION_UNAVAILABLE');
  });

  it('leaves an undelegated request on the credential-free lane', async () => {
    serviceClient.current = credentialedVerifier({ authorized: true }).oxy;

    const result = await send('/delegated', { authorization: `Bearer ${serviceToken()}` });

    // No delegated user, so no user id: a service acting as itself is not a
    // person, and `requireOxyAuth` refuses the route.
    expect(result.status).toBe(401);
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

describe('the identity the delegation lane depends on', () => {
  /**
   * The 503 branch above is a last resort, not the design: `runBootGuards`
   * refuses to open the socket unless this process can mint an Oxy service
   * token, and `lib/oxy-service-client.ts` builds the verifier from exactly the
   * same capability. If the two ever stop agreeing, the delegation lane silently
   * loses its verifier — so the coupling is asserted rather than assumed.
   *
   * Asserted as an AGREEMENT rather than as a list of variable names, because
   * the names stopped being the answer. A deployed Alia carries neither half of
   * the pair and attests its ECS task role instead (oxy ADR 0026); pinned to the
   * three names, this test would have gone green on a boot guard that refuses
   * precisely the deployment the delegation lane works on.
   */
  it.each([
    ['a credential pair', { OXY_SERVICE_API_KEY: 'oxy_dk_alia', OXY_SERVICE_API_SECRET: 's3cret' }],
    ['an attestable task role', { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }],
    ['neither', {}],
    // Half a pair is not half an identity: it REPLACES attestation with a
    // credential that cannot mint, so it has to read as no pair at all.
    ['half a pair', { OXY_SERVICE_API_KEY: 'oxy_dk_alia' }],
  ])('agrees with the client about %s', async (_case, identity) => {
    const { unsetOxyInferenceCredentialVariables } = await import(
      '../../lib/inference/oxy-inference-credential.js'
    );
    const { canAuthenticateAsOxyService } = await import('../../lib/oxy-service-client.js');

    const env = { OXY_API_URL: 'https://api.oxy.so', ...identity } as NodeJS.ProcessEnv;

    expect(unsetOxyInferenceCredentialVariables(env).length === 0).toBe(
      canAuthenticateAsOxyService(env),
    );
  });
});

describe('/internal, which documents the same delegation header', () => {
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
