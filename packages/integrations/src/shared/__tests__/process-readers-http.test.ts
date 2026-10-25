import { generateKeyPairSync, sign, verify } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIA_APPLICATION_ID,
  ALIA_API_WORKLOAD_ID,
  ALIA_SERVICE_AUDIENCE,
} from '@alia.onl/server/internal';

const fixture = vi.hoisted(() => ({
  oxy: undefined as any,
  revoked: false,
  linked: true,
  owner: '0192f3a4-b5c6-7d8e-9f01-23456789abcd',
  lookup: vi.fn(),
}));
vi.mock('../oxy', () => ({
  oxy: {
    middleware: {
      service: (options: any) => (req: any, res: any, next: any) =>
        fixture.oxy.middleware.service(options)(req, res, next),
    },
    introspectServiceToken: (token: string) => fixture.oxy.introspectServiceToken(token),
  },
}));
import { OxyServer } from '@oxy.so/core/server';
import { requireAliaApi, requireAccountContext, authorizeInternalUpgrade } from '../internal-auth';
import { accountOwnership } from '../account-ownership';

const KEY = generateKeyPairSync('ed25519');
const KID = 'process-reader-test';
const OWNER = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';
let issuer: Server;
let product: Server;
let baseURL: string;
function token(
  credentialId: string,
  overrides: Record<string, unknown> = {},
  key = KEY.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    type: 'service',
    authority: 'first_party',
    appId: ALIA_APPLICATION_ID,
    appName: 'Alia',
    credentialId,
    ownerAccountId: OWNER,
    environment: 'production',
    tier: 'internal',
    iss: 'oxy-auth',
    aud: ALIA_SERVICE_AUDIENCE,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  const data = [{ alg: 'EdDSA', typ: 'JWT', kid: KID }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
    .join('.');
  return `${data}.${sign(null, Buffer.from(data), key).toString('base64url')}`;
}
function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function origin(server: Server) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function send(path: string, headers: Record<string, string>) {
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ oxyUserId: 'forged-owner' }),
  });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  process.env.INTEGRATIONS_SECRET = 'legacy-gateway-secret';
  const app = express();
  app.use(express.json());
  app.get('/.well-known/jwks.json', (_req, res) =>
    res.json({
      keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'EdDSA' }],
    }),
  );
  app.post('/auth/resources/introspect', (req, res) => {
    // Controlled issuer endpoint; product middleware still verifies the real signature/JWKS.
    const [header, body, signature] = req.body.token.split('.');
    if (
      !verify(
        null,
        Buffer.from(`${header}.${body}`),
        KEY.publicKey,
        Buffer.from(signature, 'base64url'),
      )
    ) {
      res.json({ active: false });
      return;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    res.json(
      fixture.revoked
        ? { active: false }
        : {
            active: true,
            authority: payload.authority,
            applicationId: payload.appId,
            credentialId: payload.credentialId,
            accountId: payload.ownerAccountId,
            environment: payload.environment,
            audience: payload.aud,
            expiresAt: new Date(payload.exp * 1000).toISOString(),
            ...(payload.authority === 'external' ? { scopes: payload.scopes } : {}),
          },
    );
  });
  issuer = await listen(app);
  fixture.oxy = new OxyServer({ baseURL: origin(issuer) });
  vi.spyOn(fixture.oxy, 'introspectServiceToken').mockImplementation(async (bearer) => {
    const result = await fetch(`${origin(issuer)}/auth/resources/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bearer }),
    });
    return result.json();
  });
  const receiver = express();
  receiver.use(express.json());
  receiver.use(
    '/gateway',
    requireAliaApi,
    requireAccountContext,
    accountOwnership(async () => OWNER),
  );
  receiver.post('/gateway/sessions/:id', (req, res) => res.json({ bodyOwner: req.body.oxyUserId }));
  product = await listen(receiver);
  baseURL = origin(product);
});
beforeEach(() => {
  fixture.revoked = false;
  fixture.linked = true;
  fixture.owner = OWNER;
  fixture.lookup.mockClear();
});
afterAll(async () => {
  fixture.oxy?.dispose();
  for (const server of [product, issuer])
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.INTEGRATIONS_SECRET;
});

describe('mixed-version process readers over real HTTP', () => {
  it('keeps old producers working with no Authorization', async () => {
    expect(
      await send('/gateway/sessions/connect', {
        'x-gateway-secret': 'legacy-gateway-secret',
        'x-alia-account-context': OWNER,
      }),
    ).toMatchObject({ status: 200, body: { bodyOwner: 'forged-owner' } });
    expect(
      await authorizeInternalUpgrade({
        'x-gateway-secret': 'legacy-gateway-secret',
        'x-oxy-user-id': OWNER,
      }),
    ).toBe(OWNER);
  });
  it('accepts the exact new API workload and overwrites body owner', async () => {
    expect(
      await send('/gateway/sessions/connect', {
        authorization: `Bearer ${token(ALIA_API_WORKLOAD_ID)}`,
        'x-alia-account-context': OWNER,
      }),
    ).toMatchObject({ status: 200, body: { bodyOwner: OWNER } });
  });
  it.each(['invalid-signature', 'revoked', 'wrong-audience', 'wrong-workload', 'external'])(
    'never downgrades %s to a valid legacy secret in either direction',
    async (failure) => {
      fixture.revoked = failure === 'revoked';
      const overrides =
        failure === 'wrong-audience'
          ? { aud: 'oxy-service:other' }
          : failure === 'external'
            ? { authority: 'external', scopes: ['user:read'] }
            : {};
      const key =
        failure === 'invalid-signature'
          ? generateKeyPairSync('ed25519').privateKey
          : KEY.privateKey;
      for (const [path, workload] of [['/gateway/sessions/connect', ALIA_API_WORKLOAD_ID]]) {
        const result = await send(path, {
          authorization: `Bearer ${token(failure === 'wrong-workload' ? 'wl_other' : workload, overrides, key)}`,
          'x-channel-bot-secret': 'legacy-bot-secret',
          'x-gateway-secret': 'legacy-gateway-secret',
          'x-alia-channel': 'telegram',
          'x-alia-account-context': OWNER,
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
      }
    },
  );
  it('requires new account context and rejects another account row', async () => {
    const authorization = `Bearer ${token(ALIA_API_WORKLOAD_ID)}`;
    expect((await send('/gateway/sessions/owned', { authorization })).status).toBe(401);
    expect(
      (
        await send('/gateway/sessions/owned', {
          authorization,
          'x-alia-account-context': '0192f3a4-b5c6-7d8e-9f01-23456789abce',
        })
      ).status,
    ).toBe(404);
    expect(
      (await send('/gateway/sessions/owned', { authorization, 'x-oxy-user-id': OWNER })).status,
    ).toBe(403);
  });
  it('requires the canonical live workload audience for new sockets without legacy downgrade', async () => {
    const headers = {
      authorization: `Bearer ${token(ALIA_API_WORKLOAD_ID)}`,
      'x-alia-account-context': OWNER,
      'x-gateway-secret': 'legacy-gateway-secret',
    };
    expect(await authorizeInternalUpgrade(headers)).toBe(OWNER);
    expect(
      await authorizeInternalUpgrade({
        ...headers,
        authorization: `Bearer ${token(ALIA_API_WORKLOAD_ID, { aud: 'oxy-api' })}`,
      }),
    ).toBeNull();
    expect(
      await authorizeInternalUpgrade({
        ...headers,
        authorization: `Bearer ${token(ALIA_API_WORKLOAD_ID, {}, generateKeyPairSync('ed25519').privateKey)}`,
      }),
    ).toBeNull();
    fixture.revoked = true;
    expect(await authorizeInternalUpgrade(headers)).toBeNull();
  });
});
