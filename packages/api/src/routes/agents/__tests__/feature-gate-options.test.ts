/**
 * `GET /agents/:id/feature-gate-options` — what the agent editor may put each
 * of Alia's gateable features behind (ADR 0020 §6), for whoever operates the
 * agent: exactly the live catalogues' features a `PATCH` would accept.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  loaded: {
    ok: true,
    agent: {
      _id: 'sindi',
      featureGates: { 'attachments.documents': { app: 'homiio', feature: 'sindi.files' } },
    },
  } as { ok: boolean; agent?: unknown; refusal?: string },
  catalogs: [] as Array<{ appId: string; features?: Array<{ key: string; description: string }> }>,
  declared: new Map<string, { toolsTakeNoInput: boolean }>(),
  failing: false,
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'operator-1' }, accessToken: 'OPERATOR-TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => state.loaded),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../lib/tools/oxy-services.js', () => ({
  listOxyAppCatalogs: async () => {
    if (state.failing) throw new Error('Oxy is unreachable');
    return state.catalogs;
  },
  findOxyAppFeature: async (appId: string, key: string) => {
    const found = state.declared.get(`${appId}/${key}`);
    return found === undefined ? null : { feature: { key }, ...found };
  },
  callOxyFeatureTool: vi.fn(),
  presentPersonAgentContext: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

import router from '../feature-gates.js';

const app = express();
app.use('/agents', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function options() {
  const response = await fetch(`${base}/agents/sindi/feature-gate-options`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state.failing = false;
  state.loaded = {
    ok: true,
    agent: {
      _id: 'sindi',
      featureGates: { 'attachments.documents': { app: 'homiio', feature: 'sindi.files' } },
    },
  };
  state.catalogs = [
    {
      appId: 'homiio',
      features: [
        { key: 'sindi.files', description: 'Homiio+ files' },
        { key: 'reports', description: 'needs an input' },
      ],
    },
    { appId: 'inbox' },
    {
      appId: 'clarity',
      features: [{ key: 'deep_research', description: 'Clarity plans' }],
    },
  ];
  state.declared = new Map([
    ['homiio/sindi.files', { toolsTakeNoInput: true }],
    ['homiio/reports', { toolsTakeNoInput: false }],
    ['clarity/deep_research', { toolsTakeNoInput: true }],
  ]);
});

describe('GET /agents/:id/feature-gate-options', () => {
  it("answers Alia's gateable features, the agent's gates, and only the app features a save accepts", async () => {
    const { status, body } = await options();
    expect(status).toBe(200);
    expect(body.features).toEqual([
      'attachments.documents',
      'attachments.images',
      'deep_research',
      'power_level.pro',
      'power_level.ultra',
    ]);
    expect(body.gates).toEqual({
      'attachments.documents': { app: 'homiio', feature: 'sindi.files' },
    });
    // No catalogue without features, no feature whose tools need an input, sorted by name.
    expect(body.apps).toEqual([
      {
        appId: 'clarity',
        name: 'Clarity',
        features: [{ key: 'deep_research', description: 'Clarity plans' }],
      },
      {
        appId: 'homiio',
        name: 'Homiio',
        features: [{ key: 'sindi.files', description: 'Homiio+ files' }],
      },
    ]);
  });

  it('refuses somebody who does not operate the agent, and an agent that does not exist', async () => {
    state.loaded = { ok: false, refusal: 'not_permitted' };
    expect((await options()).status).toBe(403);
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    expect((await options()).status).toBe(404);
  });

  it('says the catalogues could not be read, rather than offering none', async () => {
    state.failing = true;
    expect((await options()).status).toBe(503);
  });
});

describe('the app editor names the same gateable features as the API', () => {
  it('holds the two lists together', async () => {
    const { GATED_FEATURES } = await import('../../../domain/agent-features.js');
    const contract = readFileSync(
      fileURLToPath(new URL('../../../../../app/src/shared/contracts/agents.ts', import.meta.url)),
      'utf8',
    );
    const declared = contract.match(/export const GATED_FEATURES = \[([^\]]*)\] as const;/)?.[1];
    expect(declared).toBeDefined();
    expect([...(declared ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([
      ...GATED_FEATURES,
    ]);
  });
});
