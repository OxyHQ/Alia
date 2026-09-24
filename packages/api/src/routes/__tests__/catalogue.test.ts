/**
 * `GET /catalogue` and `GET /v1/models` — the models Alia offers, as Oxy lists
 * them (ADR 0012), on a REAL express server so status codes, routing and
 * query parsing are express's own.
 *
 * Only the DATA SOURCES are replaced: `lib/models/catalogue.ts` (Oxy's list)
 * and `lib/models/selection.ts` (featured and default). The serializers in
 * `lib/models/wire.ts` and both routers are the shipped ones.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueModel } from '../../lib/models/catalogue.js';
import type { CatalogueResponseWire, OpenAIModelWire } from '../../lib/models/wire.js';

/** A decoded body. Loose on purpose: the assertions are what check its shape. */
interface Body extends Partial<Omit<CatalogueResponseWire, 'data'>> {
  data: Array<Record<string, unknown> & { id: string }>;
  error?: { code?: string; param?: string };
  id?: string;
}

async function read(res: globalThis.Response): Promise<Body> {
  return (await res.json()) as Body;
}

type OpenAIList = { object: string; data: OpenAIModelWire[] };

const state = vi.hoisted(() => ({
  models: [] as CatalogueModel[],
  featured: [] as string[],
  defaultModelId: null as string | null,
  catalogueFails: false,
  defaultFails: false,
  lastDefaultUser: undefined as string | null | undefined,
}));

vi.mock('../../lib/models/catalogue.js', () => ({
  listChatModels: vi.fn(async () => {
    if (state.catalogueFails) throw new Error('oxy down');
    return state.models;
  }),
}));

vi.mock('../../lib/models/selection.js', () => ({
  getFeaturedModelIds: vi.fn(async () => {
    if (state.catalogueFails) throw new Error('oxy down');
    return state.featured;
  }),
  getDefaultModelId: vi.fn(async (userId: string | null) => {
    state.lastDefaultUser = userId;
    if (state.defaultFails) throw new Error('no model');
    return state.defaultModelId;
  }),
}));

vi.mock('../../middleware/auth.js', () => ({
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    const user = req.header('x-test-user');
    if (user) (req as Request & { user?: { id: string } }).user = { id: user };
    next();
  },
}));

function model(id: string, overrides: Partial<CatalogueModel> = {}): CatalogueModel {
  const [publisher, name] = id.split('/');
  return {
    id,
    name: name.toUpperCase(),
    publisher: { id: publisher, name: publisher[0].toUpperCase() + publisher.slice(1) },
    description: null,
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: [],
    pricing: { inputPerMTok: '0.15', outputPerMTok: '0.6' },
    releasedAt: null,
    ...overrides,
  };
}

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: catalogueRouter } = await import('../catalogue.js');
  const { default: modelsRouter } = await import('../v1/models.js');
  const app = express();
  app.use('/catalogue', catalogueRouter);
  app.use('/v1/models', modelsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.models = [
    model('zeta/zed-1'),
    model('acme/alpha', {
      description: 'A model.',
      reasoningEfforts: ['low', 'medium', 'high'],
      releasedAt: '2026-05-01',
      inputModalities: ['text', 'image'],
    }),
    model('beta/bravo', { pricing: null, contextWindow: null, maxOutput: null }),
  ];
  state.featured = ['beta/bravo', 'acme/alpha'];
  state.defaultModelId = 'acme/alpha';
  state.catalogueFails = false;
  state.defaultFails = false;
  state.lastDefaultUser = undefined;
});

describe('GET /catalogue', () => {
  it('answers the list envelope with default and featured ids', async () => {
    const res = await fetch(`${base}/catalogue`);
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).sort()).toEqual(['data', 'defaultModelId', 'featuredIds', 'object']);
    expect(body.object).toBe('list');
    expect(body.defaultModelId).toBe('acme/alpha');
    expect(body.featuredIds).toEqual(['beta/bravo', 'acme/alpha']);
  });

  it('serializes each entry in the published wire shape', async () => {
    const body = await read(await fetch(`${base}/catalogue`));
    const alpha = body.data.find((entry) => entry.id === 'acme/alpha');
    expect(alpha).toEqual({
      id: 'acme/alpha',
      object: 'model',
      name: 'ALPHA',
      publisher: { id: 'acme', name: 'Acme' },
      description: 'A model.',
      contextWindow: 128_000,
      maxOutput: 8_192,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      pricing: { inputPerMTok: '0.15', outputPerMTok: '0.6' },
      releasedAt: '2026-05-01',
      featured: true,
    });
    const bravo = body.data.find((entry) => entry.id === 'beta/bravo');
    expect(bravo).toMatchObject({ pricing: null, contextWindow: null, maxOutput: null, featured: true });
    const zed = body.data.find((entry) => entry.id === 'zeta/zed-1');
    expect(zed?.featured).toBe(false);
  });

  it('lists featured models first, in picker order, then the rest', async () => {
    const body = await read(await fetch(`${base}/catalogue`));
    expect(body.data.map((entry) => entry.id)).toEqual(['beta/bravo', 'acme/alpha', 'zeta/zed-1']);
  });

  it('drops featured ids and a default the list does not contain', async () => {
    state.featured = ['gone/model', 'acme/alpha'];
    state.defaultModelId = 'gone/model';
    const body = await read(await fetch(`${base}/catalogue`));
    expect(body.featuredIds).toEqual(['acme/alpha']);
    expect(body.defaultModelId).toBeNull();
  });

  it('computes the default for the signed-in caller, or anonymously', async () => {
    await fetch(`${base}/catalogue`, { headers: { 'x-test-user': 'user-1' } });
    expect(state.lastDefaultUser).toBe('user-1');
    await fetch(`${base}/catalogue`);
    expect(state.lastDefaultUser).toBeNull();
  });

  it('still serves the list when no default can be computed', async () => {
    state.defaultFails = true;
    const res = await fetch(`${base}/catalogue`);
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.defaultModelId).toBeNull();
    expect(body.data).toHaveLength(3);
  });

  it('answers 503 catalogue_unavailable when Oxy cannot be read', async () => {
    state.catalogueFails = true;
    const res = await fetch(`${base}/catalogue`);
    expect(res.status).toBe(503);
    expect((await read(res)).error?.code).toBe('catalogue_unavailable');
  });
});

describe('GET /v1/models', () => {
  it('lists the same models in the OpenAI shape', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe('</catalogue>; rel="alternate"');
    const body = (await res.json()) as OpenAIList;
    expect(body.object).toBe('list');
    expect(body.data.map((entry) => entry.id).sort()).toEqual(
      state.models.map((entry) => entry.id).sort(),
    );
    expect(body.data.find((entry) => entry.id === 'acme/alpha')).toEqual({
      id: 'acme/alpha',
      object: 'model',
      created: Math.floor(Date.parse('2026-05-01') / 1000),
      owned_by: 'acme',
    });
    expect(body.data.find((entry) => entry.id === 'zeta/zed-1')?.created).toBe(0);
  });

  it('answers one model by its two-segment id', async () => {
    const res = await fetch(`${base}/v1/models/acme/alpha`);
    expect(res.status).toBe(200);
    expect((await read(res)).id).toBe('acme/alpha');
  });

  it('answers 404 model_not_found for a model the catalogue does not offer', async () => {
    for (const path of ['/v1/models/nobody/nothing', '/v1/models/nothing']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      const body = await read(res);
      expect(body.error).toMatchObject({ code: 'model_not_found', param: 'model' });
    }
  });

  it('answers 503 catalogue_unavailable when Oxy cannot be read', async () => {
    state.catalogueFails = true;
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(503);
    expect((await read(res)).error?.code).toBe('catalogue_unavailable');
  });
});
