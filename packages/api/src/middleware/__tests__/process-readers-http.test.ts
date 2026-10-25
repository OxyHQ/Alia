import { generateKeyPairSync, sign, verify } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIA_APPLICATION_ID,
  ALIA_INTEGRATIONS_WORKLOAD_ID,
  ALIA_SERVICE_AUDIENCE,
} from '@alia.onl/server/internal';

vi.mock('@oxy.so/core/server', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('@oxy.so/core/server');
});
const fixture = vi.hoisted(() => ({
  oxy: undefined as any,
  revoked: false,
  linked: true,
  owner: '0192f3a4-b5c6-7d8e-9f01-23456789abcd',
  lookup: vi.fn(),
}));
vi.mock('../../lib/channel-workload-verifier.js', () => ({
  channelWorkloadVerifier: () => fixture.oxy,
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/botRepository.js', () => ({
  findSystemBot: async () => ({ id: 'system-bot', status: 'active' }),
  findBotUser: async (_db: unknown, bot: string, providerUser: string) => {
    fixture.lookup(bot, providerUser);
    return fixture.linked ? { id: 'linked-row', isLinked: true, oxyUserId: fixture.owner } : null;
  },
}));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  findConnectedAccountBySession: async (_db: unknown, platform: string, session: string) => {
    fixture.lookup(platform, session);
    return fixture.linked ? { id: 'account-row', oxyUserId: fixture.owner } : null;
  },
}));
vi.mock('../../lib/channels/registry.js', () => ({
  getChannel: () => ({ config: { getBotSecret: () => 'legacy-bot-secret' } }),
}));
import { OxyServer } from '@oxy.so/core/server';
import { authenticateChannelAccount, authenticateChannelBot } from '../channel-auth.js';

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
  return {
    status: response.status,
    body: (await response.json()) as { context?: Record<string, unknown> },
  };
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
  receiver.post('/api/bot', authenticateChannelBot('telegram'), (req, res) =>
    res.json({ channel: req.channelType }),
  );
  receiver.post('/api/channel', authenticateChannelAccount, (req, res) =>
    res.json({
      context: req.channelContext,
      user: req.user ?? null,
      bearer: req.accessToken ?? null,
    }),
  );
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
    expect((await send('/api/bot', { 'x-channel-bot-secret': 'legacy-bot-secret' })).status).toBe(
      200,
    );
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
      for (const [path, workload] of [['/api/bot', ALIA_INTEGRATIONS_WORKLOAD_ID]]) {
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
  it.each([
    ['telegram', 'x-alia-platform-user', 'remote-user', 'system-bot'],
    ['whatsapp', 'x-alia-channel-session', 'session-owner', 'whatsapp'],
  ])(
    'resolves %s account from its live provider row without Oxy authority',
    async (platform, header, value, lookupKey) => {
      const headers = {
        authorization: `Bearer ${token(ALIA_INTEGRATIONS_WORKLOAD_ID)}`,
        'x-alia-channel': platform,
        [header]: value,
        'x-alia-account-context': 'forged-account',
      };
      expect(await send('/api/channel', headers)).toMatchObject({
        status: 200,
        body: { context: { accountId: OWNER }, user: null, bearer: null },
      });
      expect(fixture.lookup).toHaveBeenCalledWith(lookupKey, value);
      const result = await send('/api/channel', headers);
      expect(result.body.context).not.toHaveProperty('taskId');
      fixture.linked = false;
      expect((await send('/api/channel', headers)).status).toBe(401);
    },
  );
  it('accepts new administrative bot calls only for their declared channel', async () => {
    const headers = {
      authorization: `Bearer ${token(ALIA_INTEGRATIONS_WORKLOAD_ID)}`,
      'x-alia-channel': 'telegram',
    };
    expect((await send('/api/bot', headers)).status).toBe(200);
    expect((await send('/api/bot', { ...headers, 'x-alia-channel': 'discord' })).status).toBe(403);
    expect((await send('/api/channel', headers)).status).toBe(401);
  });
});
