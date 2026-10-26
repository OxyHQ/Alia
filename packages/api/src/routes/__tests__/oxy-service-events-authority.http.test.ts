import { generateKeyPairSync, sign, verify } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALIA_SERVICE_AUDIENCE } from '@alia.onl/server/internal';

vi.mock('@oxy.so/core/server', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('@oxy.so/core/server');
});
const state = vi.hoisted(() => ({
  oxy: undefined as any,
  revoked: false,
  catalogOwner: '',
  catalogActive: true,
  scopes: ['capability-events:publish'],
  claim: vi.fn(async () => false),
  catalogueReads: 0,
}));
vi.mock('../../lib/oxy-service-client.js', () => ({ oxyServiceClient: () => state.oxy }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  claimAutomationEvent: state.claim,
  markAutomationEventStatus: vi.fn(),
  matchingEventAutomations: vi.fn(async () => []),
}));
vi.mock('../../lib/automation-dispatcher.js', () => ({ dispatchStructuredAutomation: vi.fn() }));
vi.mock('../../lib/notification-service.js', () => ({ sendNotification: vi.fn() }));
vi.mock('../../lib/proactive/email-outreach.js', () => ({ handleInboxEmailEvent: vi.fn() }));
import { OxyServer } from '@oxy.so/core/server';
import router from '../oxy-service-events.js';

const keys = generateKeyPairSync('ed25519');
const owner = '69b2d3df5d12f58c9800d651';
const nilo = 'ed143b1b58d60eab417f7d5c';
const inboxPublisher = '6a37b3e61ddfd195b656819b';
let issuer: Server;
let product: Server;
function origin(server: Server) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function listen(app: express.Express) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function token(appId: string, lane: 'v1' | 'v2' | 'external', aud?: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    type: 'service',
    appId,
    appName: 'Publisher',
    ownerAccountId: owner,
    credentialId: lane === 'external' ? 'customer-key' : `wl_${appId}`,
    environment: 'production',
    tier: 'internal',
    iss: 'oxy-auth',
    iat: now,
    exp: now + 300,
    aud: aud ?? (lane === 'v2' ? ALIA_SERVICE_AUDIENCE : 'oxy-api'),
    ...(lane === 'v2' ? { authority: 'first_party' } : { scopes: ['capability-events:publish'] }),
  };
  const data = [{ alg: 'EdDSA', typ: 'JWT', kid: 'events' }, payload]
    .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
    .join('.');
  return `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString('base64url')}`;
}
async function post(bearer: string, appId = 'nilo') {
  return fetch(`${origin(product)}/webhooks/oxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      eventId: 'event-1',
      appId,
      accountId: owner,
      resource: { appId, effectiveAccountId: owner, resourceType: 'item', resourceId: 'item-1' },
      type: 'changed',
      occurredAt: new Date().toISOString(),
      data: {},
    }),
  });
}
beforeAll(async () => {
  const authority = express();
  authority.use(express.json());
  authority.get('/.well-known/jwks.json', (_req, res) =>
    res.json({
      keys: [
        { ...keys.publicKey.export({ format: 'jwk' }), kid: 'events', use: 'sig', alg: 'EdDSA' },
      ],
    }),
  );
  authority.post('/auth/resources/introspect', (req, res) => {
    const [header, body, signature] = req.body.token.split('.');
    if (
      !verify(
        null,
        Buffer.from(`${header}.${body}`),
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      )
    )
      return res.json({ active: false });
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    // Controlled central authority: the receiver does not infer the finite v1
    // cohort itself. Customer keys remain external even with an internal tier.
    const own =
      claims.authority === 'first_party' ||
      (claims.credentialId.startsWith('wl_') && [nilo, inboxPublisher].includes(claims.appId));
    res.json(
      state.revoked
        ? { active: false }
        : {
            active: true,
            authority: own ? 'first_party' : 'external',
            applicationId: claims.appId,
            credentialId: claims.credentialId,
            accountId: claims.ownerAccountId,
            environment: claims.environment,
            audience: claims.aud,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
            ...(own ? {} : { scopes: state.scopes }),
          },
    );
  });
  authority.get('/capabilities/catalogs', (req, res) => {
    state.catalogueReads++;
    res.json({
      registrations: [
        {
          appSlug: req.query.appId,
          registeredByApplicationId: state.catalogOwner,
          active: state.catalogActive,
          catalog: { events: [{ type: 'changed' }] },
        },
      ],
    });
  });
  issuer = await listen(authority);
  state.oxy = new OxyServer({ baseURL: origin(issuer) });
  vi.spyOn(state.oxy, 'introspectServiceToken').mockImplementation(async (bearer) => {
    const response = await fetch(`${origin(issuer)}/auth/resources/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bearer }),
    });
    return response.json();
  });
  vi.spyOn(state.oxy.agency, 'serviceCatalogs').mockImplementation(async (input: any) => {
    const response = await fetch(
      `${origin(issuer)}/capabilities/catalogs?appId=${encodeURIComponent(input.appId)}`,
    );
    return ((await response.json()) as any).registrations;
  });
  const app = express();
  app.use(express.json());
  app.use('/webhooks/oxy', router);
  product = await listen(app);
});
beforeEach(() => {
  state.revoked = false;
  state.catalogActive = true;
  state.catalogOwner = nilo;
  state.scopes = ['capability-events:publish'];
  state.catalogueReads = 0;
  state.claim.mockClear();
});
afterAll(async () => {
  state.oxy.dispose();
  for (const server of [product, issuer])
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('event receiver with real signed service credentials and live Oxy reads', () => {
  it.each([
    ['nilo', nilo],
    ['inbox', inboxPublisher],
  ])(
    'rejects retired %s v1 and accepts canonical scope-free v2 without changing deduplication',
    async (slug, appId) => {
      state.catalogOwner = appId;
      expect((await post(token(appId, 'v1'), slug)).status).toBe(401);
      expect(state.claim).not.toHaveBeenCalled();
      expect(state.catalogueReads).toBe(0);
      const response = await post(token(appId, 'v2'), slug);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, duplicate: true });
      expect(state.claim).toHaveBeenCalledOnce();
    },
  );
  it('rejects revoked, wrong-recipient and forged service credentials before claiming', async () => {
    state.revoked = true;
    expect((await post(token(nilo, 'v2'))).status).toBe(401);
    state.revoked = false;
    expect((await post(token(nilo, 'v2', 'oxy-service:other'))).status).toBe(401);
    expect(
      (await post(`${token(nilo, 'v2').split('.').slice(0, 2).join('.')}.invalid`)).status,
    ).toBe(401);
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.catalogueReads).toBe(0);
  });
  it('rechecks registry ownership and active state on every event', async () => {
    const credential = token(nilo, 'v2');
    expect((await post(credential)).status).toBe(202);
    state.catalogOwner = inboxPublisher;
    expect((await post(credential)).status).toBe(403);
    state.catalogOwner = nilo;
    state.catalogActive = false;
    expect((await post(credential)).status).toBe(403);
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(state.catalogueReads).toBe(3);
  });
  it('preserves live external scope restrictions despite internal customer-key branding', async () => {
    const credential = token(nilo, 'external');
    expect((await post(credential)).status).toBe(202);
    state.scopes = [];
    expect((await post(credential)).status).toBe(403);
    expect(state.claim).toHaveBeenCalledTimes(1);
  });
});
