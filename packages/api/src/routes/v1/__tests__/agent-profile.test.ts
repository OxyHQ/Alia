/**
 * What an embedding app reads about an agent (`docs/agent-embedding.md` §1, §5):
 * its profile and the person's features, under the person's session, and the
 * same 404 for every agent the person may not use.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  turnAgent: { kind: 'unavailable', reason: 'not_found' } as Record<string, unknown>,
  features: null as unknown,
  unavailable: false,
  loadTurnAgent: vi.fn(),
}));

vi.mock('../../../lib/agent-account.js', () => ({
  loadTurnAgent: async (...args: unknown[]) => {
    state.loadTurnAgent(...args);
    return state.turnAgent;
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { agents: child } };
});
vi.mock('../../../lib/agent-features.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/agent-features.js')>();
  return {
    ...actual,
    readAgentFeatures: async () => {
      if (state.unavailable) throw new actual.FeatureCheckUnavailableError('attachments.documents');
      return state.features;
    },
  };
});

const { default: agentsRouter } = await import('../agents.js');

const SINDI = {
  _id: 'sindi',
  id: 'sindi',
  oxyAccountId: 'sindi-bot',
  ownerOxyAccountId: 'homiio-project',
  applicationId: null,
  name: 'Sindi',
  handle: 'sindibot',
  color: 'teal',
  authorName: 'Homiio',
  character: { shape: 'heart', eyes: 'oval', eyewear: 'none', accessory: 'bow', color: 'teal' },
  tagline: 'Your housing assistant',
  description: 'Finds homes and knows tenancy law.',
  systemPrompt: 'never shown',
  starters: [{ title: 'Lease review', prompt: 'Can you review my lease?' }],
  featureGates: { 'attachments.documents': { app: 'homiio', feature: 'files' } },
  access: 'public',
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'person-1' }, accessToken: 'PERSON-TOKEN' });
    next();
  });
  app.use('/v1/agents', agentsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  state.turnAgent = { kind: 'agent', agent: SINDI };
  state.unavailable = false;
  state.features = [{ key: 'attachments.documents', state: 'locked' }];
});

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('GET /v1/agents/:id/profile', () => {
  it('answers the lead participant, without the prompt', async () => {
    const res = await get('/v1/agents/sindi/profile');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'sindi',
      name: 'Sindi',
      handle: 'sindibot',
      character: SINDI.character,
      color: 'teal',
      description: 'Finds homes and knows tenancy law.',
      greeting: 'Your housing assistant',
      starters: SINDI.starters,
      access: 'public',
      features: [
        { key: 'attachments.documents', gated: true },
        { key: 'attachments.images', gated: false },
        { key: 'deep_research', gated: false },
        { key: 'power_level.pro', gated: false },
        { key: 'power_level.ultra', gated: false },
      ],
    });
    expect(state.loadTurnAgent).toHaveBeenCalledWith(
      {},
      { agentId: 'sindi', oxyUserId: 'person-1', accessToken: 'PERSON-TOKEN' },
    );
  });

  it.each([
    { kind: 'unavailable', reason: 'not_found' },
    { kind: 'unavailable', reason: 'out_of_reach' },
    { kind: 'identity_unavailable' },
  ])('is the same 404 for $kind $reason', async (turnAgent) => {
    state.turnAgent = turnAgent;
    const res = await get('/v1/agents/private-one/profile');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found' });
  });
});

describe('GET /v1/agents/:id/features', () => {
  it("answers the person's features as the apps behind the gates answered", async () => {
    const res = await get('/v1/agents/sindi/features');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ features: [{ key: 'attachments.documents', state: 'locked' }] });
  });

  it('is 503 when an app could not answer, never a guessed state', async () => {
    state.unavailable = true;
    const res = await get('/v1/agents/sindi/features');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'feature_check_unavailable',
      feature: 'attachments.documents',
      retryable: true,
    });
  });

  it('is 404 for an agent the person may not use', async () => {
    state.turnAgent = { kind: 'unavailable', reason: 'out_of_reach' };
    expect((await get('/v1/agents/private-one/features')).status).toBe(404);
  });
});
