/**
 * `GET /catalogue` — the wire shape, the filters, and what happens when a
 * filter cannot be evaluated.
 *
 * A REAL express server on a real port, because three of the properties under
 * test are express's and not the handler's: query parsing (`?entitled=true` is
 * a string), status codes, and the fact that the router is reachable at all.
 * Calling the handler function directly would assert none of them.
 *
 * Only the DATA SOURCES are replaced — `gateway-client` and `plan-access`, the
 * two seams `lib/catalogue.ts` reads through. The serializer, the filters and
 * the refusals are the shipped ones.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FixtureModel {
  id: string;
  name: string;
  tier: string;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: string;
  emoji?: string;
  chatVisible?: boolean;
  isAvailable: boolean;
  isLegacy: boolean;
}

interface FixtureMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: string;
  capabilities: Record<string, unknown>;
}

interface FixturePlan {
  planId: string;
  name: string;
  product: string;
  monthlyPrice: number;
  isFree: boolean;
  modelIds: string[];
  isActive: boolean;
}

/**
 * Mutable between tests, and shared with the mocks below through `vi.hoisted`
 * so the factories can close over it — a plain module-level `const` would be
 * initialised after the hoisted `vi.mock` calls and read as `undefined`.
 */
const state = vi.hoisted(() => ({
  models: [] as unknown[],
  mappings: {} as Record<string, unknown[]>,
  plans: [] as unknown[],
  plansThrow: false,
  entitlementsThrow: false,
  allowedModelIds: [] as string[],
  userId: null as string | null,
}));

vi.mock('../../lib/gateway-client.js', () => ({
  getAvailableModels: async () => state.models,
  getTierMappings: async () => state.mappings,
  getPlans: async () => {
    if (state.plansThrow) throw new Error('plan catalogue unreachable');
    return state.plans;
  },
}));

vi.mock('../../lib/plan-access.js', () => ({
  getUserEntitlements: async () => {
    if (state.entitlementsThrow) throw new Error('entitlements unreachable');
    return { allowedModelIds: state.allowedModelIds, features: {}, planId: 'free' };
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    if (state.userId !== null) {
      (req as Request & { user?: { id: string } }).user = { id: state.userId };
    }
    next();
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { models: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: catalogueRouter } = await import('../catalogue.js');

interface CatalogueBody {
  object?: string;
  entitlements_known?: boolean;
  data?: Record<string, unknown>[];
  error?: { message?: string; param?: string | null; code?: string | null };
}

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app: Express = express();
  app.use('/catalogue', catalogueRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function model(overrides: Partial<FixtureModel> = {}): FixtureModel {
  return {
    id: 'alia-lite',
    name: 'Alia Lite',
    tier: 'lite',
    description: 'Fast responses',
    creditMultiplier: 0.5,
    maxTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
    emoji: '⚡',
    chatVisible: true,
    isAvailable: true,
    isLegacy: false,
    ...overrides,
  };
}

function mapping(modelId: string, capabilities: Record<string, unknown> = {}): FixtureMapping {
  return {
    provider: 'acme',
    modelId,
    priority: 1,
    qualityScore: 50,
    pricingTier: 'paid',
    capabilities: {
      tools: true,
      vision: false,
      audio: false,
      maxContextTokens: 128000,
      maxOutputTokens: 8192,
      ...capabilities,
    },
  };
}

function plan(overrides: Partial<FixturePlan> = {}): FixturePlan {
  return {
    planId: 'free',
    name: 'Free',
    product: 'alia',
    monthlyPrice: 0,
    isFree: true,
    modelIds: ['alia-lite'],
    isActive: true,
    ...overrides,
  };
}

async function get(path: string): Promise<{ status: number; body: CatalogueBody }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as CatalogueBody };
}

beforeEach(() => {
  state.models = [
    model(),
    model({ id: 'alia-v1-codea', name: 'Codea', tier: 'v1-codea', category: 'coding', creditMultiplier: 1.5, chatVisible: false }),
    model({ id: 'alia-v1-pro', name: 'Codea Pro', tier: 'v1-pro', creditMultiplier: 3, chatVisible: true }),
  ];
  state.mappings = {
    lite: [mapping('one'), mapping('two', { vision: true })],
    'v1-codea': [mapping('three')],
    'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
  };
  state.plans = [
    plan(),
    plan({ planId: 'go', name: 'Go', monthlyPrice: 399, isFree: false, modelIds: ['alia-lite', 'alia-v1-codea'] }),
    plan({ planId: 'codea-pro', name: 'Codea Pro', product: 'codea', monthlyPrice: 999, isFree: false, modelIds: ['alia-v1-codea', 'alia-v1-pro'] }),
  ];
  state.plansThrow = false;
  state.entitlementsThrow = false;
  state.allowedModelIds = ['alia-lite'];
  state.userId = null;
});

describe('the catalogue distinguishes a model from a routing profile by TYPE', () => {
  it('serves the two kinds under two different object values', async () => {
    const { status, body } = await get('/catalogue');
    expect(status).toBe(200);
    expect(body.object).toBe('list');

    const byId = new Map((body.data ?? []).map((e) => [String(e.id), e]));
    expect([...byId.keys()].sort()).toEqual(['alia-lite', 'alia-v1-codea', 'alia-v1-pro']);

    // Two candidates: a policy over two models.
    expect(byId.get('alia-lite')?.object).toBe('routing_profile');
    expect(byId.get('alia-lite')?.profile_id).toBe('profile:lite');
    expect(byId.get('alia-lite')?.selects_among).toBe(2);

    // One candidate: a reference to that model, so it keeps `model` — the value
    // a client already switches on.
    expect(byId.get('alia-v1-codea')?.object).toBe('model');
    expect(byId.get('alia-v1-codea')?.publisher).toBeNull();
    expect(byId.get('alia-v1-codea')?.profile_id).toBeUndefined();
  });

  it('reports capability availability per entry, with unknown distinct from never', async () => {
    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.capabilities).toEqual({
      // One of two candidates has vision, so neither `true` nor `false` is the
      // honest answer. The fixture alias declares `supportsVision: false`, which
      // is the value `/v1/models` publishes and the one this must NOT return.
      vision: 'sometimes',
      tools: 'always',
      audio: 'never',
      reasoning: 'unknown',
      structured_output: 'unknown',
      context_window: { guaranteed: 128000, up_to: 128000 },
      max_output: { guaranteed: 8192, up_to: 8192 },
      // `sometimes` is only true of the policy that walks the whole list, so the
      // block names it rather than leaving a client to assume.
      under_policy: 'cross-model',
    });
  });
});

describe('entitlement comes from the plan catalogue, and says so when it cannot', () => {
  it('annotates each entry with how it is reached', async () => {
    const { body } = await get('/catalogue');
    expect(body.entitlements_known).toBe(true);
    const byId = new Map((body.data ?? []).map((e) => [String(e.id), e]));
    expect(byId.get('alia-lite')?.entitlement).toEqual({
      state: 'known',
      access: 'free',
      required_plan: null,
      granted_by: ['free', 'go'],
      products: ['alia'],
      entitled: null,
    });
    expect(byId.get('alia-v1-pro')?.entitlement).toMatchObject({
      access: 'plan',
      required_plan: 'Codea Pro',
      products: ['codea'],
    });
  });

  it('reports entitled once a caller is known, without hiding anything', async () => {
    state.userId = 'user-1';
    const { body } = await get('/catalogue');
    const byId = new Map((body.data ?? []).map((e) => [String(e.id), e]));
    expect((byId.get('alia-lite')?.entitlement as { entitled?: unknown }).entitled).toBe(true);
    expect((byId.get('alia-v1-pro')?.entitlement as { entitled?: unknown }).entitled).toBe(false);
    // Not entitled is not hidden: a picker needs the locked entry to explain the
    // upgrade. Filtering is opt-in, below.
    expect(body.data).toHaveLength(3);
  });

  it('degrades an ANNOTATION to unknown when the plan catalogue is unreachable', async () => {
    state.plansThrow = true;
    const { status, body } = await get('/catalogue');
    expect(status).toBe(200);
    expect(body.entitlements_known).toBe(false);
    expect(body.data).toHaveLength(3);
    for (const entry of body.data ?? []) expect(entry.entitlement).toEqual({ state: 'unknown' });
  });
});

describe('a filter that cannot be evaluated refuses instead of answering', () => {
  it('filters by Alia product policy', async () => {
    const { status, body } = await get('/catalogue?product=codea');
    expect(status).toBe(200);
    expect((body.data ?? []).map((e) => e.id).sort()).toEqual(['alia-v1-codea', 'alia-v1-pro']);
  });

  it('rejects a product outside the plan vocabulary', async () => {
    const { status, body } = await get('/catalogue?product=nope');
    expect(status).toBe(400);
    expect(body.error?.param).toBe('product');
  });

  it('filters by plan entitlement for an authenticated caller', async () => {
    state.userId = 'user-1';
    const { status, body } = await get('/catalogue?entitled=true');
    expect(status).toBe(200);
    expect((body.data ?? []).map((e) => e.id)).toEqual(['alia-lite']);
  });

  it('refuses to filter by entitlement without a caller, rather than inventing a free tier', async () => {
    const { status, body } = await get('/catalogue?entitled=true');
    expect(status).toBe(401);
    expect(body.error?.param).toBe('entitled');
    expect(body.data).toBeUndefined();
  });

  it('refuses a product filter it cannot evaluate, rather than serving everything', async () => {
    // The failure this guards against: `?product=codea` answering 200 with all
    // three entries, which is indistinguishable from a correct answer.
    state.plansThrow = true;
    const { status, body } = await get('/catalogue?product=codea');
    expect(status).toBe(503);
    expect(body.error?.code).toBe('filter_unavailable');
    expect(body.data).toBeUndefined();
  });

  it('refuses an entitlement filter it cannot evaluate', async () => {
    state.userId = 'user-1';
    state.entitlementsThrow = true;
    const { status, body } = await get('/catalogue?entitled=true');
    expect(status).toBe(503);
    expect(body.error?.param).toBe('entitled');
  });

  it('still serves the unfiltered catalogue when entitlements are unreachable', async () => {
    // The other half of the rule: annotation degrades, filtering refuses. A
    // catalogue that 503s because one annotation is missing would be worse than
    // one that says `unknown`.
    state.userId = 'user-1';
    state.entitlementsThrow = true;
    const { status, body } = await get('/catalogue');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(3);
    for (const entry of body.data ?? []) {
      expect((entry.entitlement as { entitled?: unknown }).entitled).toBeNull();
    }
  });
});

describe('the catalogue carries the compatibility-window signal', () => {
  it('marks the deprecated aliases and announces no removal date', async () => {
    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.deprecation).toEqual({ deprecated_at: '2026-08-15T00:00:00.000Z', sunset_at: null });

    // Negative control, so "everything is marked" cannot pass for "the right
    // things are marked".
    state.models = [model({ id: 'not-an-alias', tier: 'lite' })];
    const other = await get('/catalogue');
    expect(other.body.data?.[0].deprecation).toBeNull();
  });
});
