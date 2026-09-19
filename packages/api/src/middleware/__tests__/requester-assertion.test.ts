import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `X-Oxy-Requester-Assertion` on `/v1/chat/completions` (ADR 0025 in
 * OxyHQServices), through the REAL `@oxy.so/core/server` verifier.
 *
 * A product (Homiio) presents its own service token plus a one-use assertion
 * Oxy minted for a signed-in person. The only way `req.user` may come out of
 * this middleware is: signature valid against Oxy's JWKS, audience `alia`,
 * minted for exactly the presenting application and credential, and consumed
 * live by Oxy's introspection using ALIA's own service client. Every other
 * outcome is a refusal, and most of them must happen before the assertion can
 * even be spent.
 */

const introspect = vi.hoisted(() => vi.fn());
const serviceClient = vi.hoisted(() => ({ configured: true }));

vi.mock('../../lib/oxy-service-client.js', () => ({
  oxyServiceClient: () => serviceClient.configured
    ? { introspectRequesterAssertion: introspect, getBaseURL: () => 'https://api.oxy.so' }
    : null,
}));
vi.mock('../../lib/logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: () => [] }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

const { signOxyRequesterAssertion } = await import('@oxy.so/core/server');
const { authenticateRequesterAssertion, resetRequesterAssertionAuth } = await import('../auth.js');

const KEY = generateKeyPairSync('ed25519');
const OTHER_KEY = generateKeyPairSync('ed25519');
const KID = 'cap-alia-test';
const HOMIIO_APP = '6a2f851751b784a86fd0e922';
const SINDI_CREDENTIAL = '01a0648e-ad3f-7608-aa8b-c07bfef6cf73';
const SINDI_AGENT = '01a0646a-078f-7514-9800-9f43ceed7df8';
const USER = '6981c9178fcdefaf81988ffb';

function assertion(overrides: Record<string, unknown> = {}, privateKey = KEY.privateKey, keyId = KID): string {
  const iat = Math.floor(Date.now() / 1000);
  return signOxyRequesterAssertion({
    iss: 'https://api.oxy.so',
    aud: 'alia',
    sub: USER,
    jti: randomUUID(),
    iat,
    exp: iat + 120,
    azp: HOMIIO_APP,
    cid: SINDI_CREDENTIAL,
    agentId: SINDI_AGENT,
    ...overrides,
  } as never, { keyId, privateKey });
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8'));
}

function activeFor(token: string) {
  const claims = claimsOf(token);
  return {
    active: true,
    requesterAccountId: claims.sub,
    agentId: claims.agentId,
    applicationId: claims.azp,
    credentialId: claims.cid,
    jti: claims.jti,
    expiresAt: new Date((claims.exp as number) * 1000).toISOString(),
  };
}

let server: http.Server;

/** Stands in for `createOxyAuthMiddleware`: a VERIFIED service token for the given principal. */
function serviceTokenVerified(req: Request, _res: Response, next: NextFunction): void {
  const app = req.headers['x-test-app'];
  if (typeof app === 'string') {
    req.serviceApp = {
      appId: app,
      appName: 'test',
      credentialId: String(req.headers['x-test-credential']),
      ownerAccountId: 'owner',
      scopes: ['inference:invoke'],
      environment: 'production',
    } as never;
    req.user = null;
    req.userId = undefined;
  }
  next();
}

async function send(headers: Record<string, string>) {
  const { port } = server.address() as AddressInfo;
  const response = await fetchReal(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const fetchReal = globalThis.fetch;
const homiio = { 'x-test-app': HOMIIO_APP, 'x-test-credential': SINDI_CREDENTIAL };

beforeAll(async () => {
  const jwk = { ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'EdDSA' };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input) === 'https://api.oxy.so/capabilities/.well-known/jwks.json') {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return fetchReal(input, init);
  });
  const app = express();
  app.use(express.json());
  app.use(serviceTokenVerified);
  app.post('/v1/chat/completions', authenticateRequesterAssertion, (req, res) => {
    res.json({ userId: req.user?.id ?? null, requester: req.oxyRequester ?? null });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  introspect.mockReset();
  serviceClient.configured = true;
  resetRequesterAssertionAuth();
});

describe('present-requester assertions on /v1/chat/completions', () => {
  it('leaves requests without the header untouched', async () => {
    const result = await send(homiio);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ userId: null, requester: null });
    expect(introspect).not.toHaveBeenCalled();
  });

  it('derives the requester from the introspected assertion, never from a header', async () => {
    const token = assertion();
    introspect.mockResolvedValueOnce(activeFor(token));
    const result = await send({ ...homiio, 'x-oxy-requester-assertion': token });
    expect(result.status).toBe(200);
    expect(result.body.userId).toBe(USER);
    expect(result.body.requester).toMatchObject({ userId: USER, agentId: SINDI_AGENT, applicationId: HOMIIO_APP });
    expect(introspect).toHaveBeenCalledWith({
      assertion: token,
      presenter: { applicationId: HOMIIO_APP, credentialId: SINDI_CREDENTIAL },
    });
  });

  it('refuses a replay: Oxy answers inactive the second time', async () => {
    const token = assertion();
    introspect.mockResolvedValueOnce(activeFor(token)).mockResolvedValueOnce({ active: false });
    expect((await send({ ...homiio, 'x-oxy-requester-assertion': token })).status).toBe(200);
    const replay = await send({ ...homiio, 'x-oxy-requester-assertion': token });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('REQUESTER_ASSERTION_INACTIVE');
  });

  it('refuses a forged, expired or wrong-audience assertion without asking Oxy', async () => {
    for (const [token, code] of [
      [assertion({}, OTHER_KEY.privateKey), 'invalid_signature'],
      [assertion({}, KEY.privateKey, 'unpublished-kid'), 'unknown_key'],
      [assertion({ iat: Math.floor(Date.now() / 1000) - 400, exp: Math.floor(Date.now() / 1000) - 280 }), 'expired'],
      [assertion({ aud: 'syra' }), 'wrong_audience'],
      [assertion({ iss: 'https://evil.example' }), 'wrong_issuer'],
    ] as const) {
      const result = await send({ ...homiio, 'x-oxy-requester-assertion': token });
      expect(result.status).toBe(401);
      expect(result.body.code).toBe(code);
    }
    expect(introspect).not.toHaveBeenCalled();
  });

  it('refuses an assertion presented by another application or credential', async () => {
    const token = assertion();
    for (const presenter of [
      { 'x-test-app': 'another-official-app', 'x-test-credential': SINDI_CREDENTIAL },
      { 'x-test-app': HOMIIO_APP, 'x-test-credential': 'another-credential' },
    ]) {
      const result = await send({ ...presenter, 'x-oxy-requester-assertion': token });
      expect(result.status).toBe(401);
      expect(result.body.code).toBe('presenter_mismatch');
    }
    expect(introspect).not.toHaveBeenCalled();
  });

  it('refuses an assertion with no service token (a human bearer cannot present one)', async () => {
    const result = await send({ 'x-oxy-requester-assertion': assertion() });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('service_token_required');
  });

  it('refuses to combine with offline delegation', async () => {
    const result = await send({ ...homiio, 'x-oxy-requester-assertion': assertion(), 'x-oxy-user-id': 'someone-else' });
    expect(result.status).toBe(400);
    expect(introspect).not.toHaveBeenCalled();
  });

  it('refuses when Oxy disagrees with the claims it is asked about', async () => {
    const token = assertion();
    introspect.mockResolvedValueOnce({ ...activeFor(token), requesterAccountId: 'victim' });
    const result = await send({ ...homiio, 'x-oxy-requester-assertion': token });
    expect(result.status).toBe(401);
    expect(result.body.userId).toBeUndefined();
  });

  it('fails closed when Oxy cannot be asked or Alia has no credential to ask with', async () => {
    introspect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await send({ ...homiio, 'x-oxy-requester-assertion': assertion() })).status).toBe(503);

    serviceClient.configured = false;
    resetRequesterAssertionAuth();
    expect((await send({ ...homiio, 'x-oxy-requester-assertion': assertion() })).status).toBe(503);
  });
});
