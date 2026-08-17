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
  isAvailable: boolean;
  isLegacy: boolean;
}

interface FixtureLicense {
  licenseId: string;
  displayName: string;
  url?: string;
  commercialUseAllowed: boolean;
  requiresAttribution: boolean;
  acceptableUsePolicyUrl?: string;
}

interface FixtureAttribution {
  license: FixtureLicense;
  attributedModel: string;
}

interface FixtureMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: string;
  capabilities: Record<string, unknown>;
  /**
   * The two facts a Relay deployment carries and no route in this repository
   * does. Absent by default, exactly as production is, so a fixture that sets
   * either is the only place the consumption is exercised — and the response's
   * own `filters.availability_scope.declared_routes` distinguishes the two
   * states, which is the assertion that stops "nothing to filter" reading as
   * "the filter works".
   */
  availabilityScope?: string;
  attribution?: FixtureAttribution;
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
  /** An `alia_sk_` developer key, as `authenticateApiKey` would leave it. */
  apiKeyId: null as string | null,
  /** A verified Oxy service token, as `oxyServiceAuth` would leave it. */
  serviceAppId: null as string | null,
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

/**
 * Stands in for the auth middleware by leaving on the request exactly what the
 * real one leaves: `req.user` for an Oxy session, `req.apiKey` for an
 * `alia_sk_` developer key, `req.serviceApp` for a verified service token. The
 * route then runs the SHIPPED `resolveCallerAudience` over it, so what is under
 * test is the real classification and not a fixture's opinion of it.
 *
 * `authenticateApiKey` sets `req.user` as well as `req.apiKey`, and this mock
 * reproduces that, because a resolver that read `req.user` first would call
 * every developer key a session — which is the bug the ordering exists to
 * avoid, and it cannot be measured against a mock that keeps them apart.
 */
vi.mock('../../middleware/auth.js', () => ({
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    const typed = req as Request & {
      user?: { id: string };
      apiKey?: { id: string; appId: string; userId: string; scopes: string[] };
      serviceApp?: { appId: string; appName: string; scopes: string[]; credentialId: string; environment: 'development' | 'staging' | 'production' };
    };
    if (state.userId !== null) typed.user = { id: state.userId };
    if (state.apiKeyId !== null) {
      typed.apiKey = { id: state.apiKeyId, appId: 'app', userId: 'key-owner', scopes: [] };
      typed.user = { id: 'key-owner' };
    }
    if (state.serviceAppId !== null) {
      typed.serviceApp = {
        appId: state.serviceAppId,
        appName: 'Alia',
        scopes: [],
        credentialId: 'credential',
        environment: 'development',
      };
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
  filters?: {
    availability_scope?: { declared_routes?: number; withheld_entries?: number };
    platform_capability?: { surface?: string | null; withheld_entries?: number };
    region?: { applied?: boolean; delegated_to?: string };
    attributed_routes?: number;
  };
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
    isAvailable: true,
    isLegacy: false,
    ...overrides,
  };
}

function mapping(
  modelId: string,
  capabilities: Record<string, unknown> = {},
  route: Partial<Pick<FixtureMapping, 'availabilityScope' | 'attribution'>> = {},
): FixtureMapping {
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
    ...route,
  };
}

/** A licence record that requires the base model be named. */
function license(overrides: Partial<FixtureLicense> = {}): FixtureLicense {
  return {
    licenseId: 'fixture-community-1.0',
    displayName: 'Fixture Community License 1.0',
    url: 'https://example.invalid/license',
    commercialUseAllowed: true,
    requiresAttribution: true,
    ...overrides,
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
    model({ id: 'alia-v1-codea', name: 'Codea', tier: 'v1-codea', category: 'coding', creditMultiplier: 1.5 }),
    model({ id: 'alia-v1-pro', name: 'Codea Pro', tier: 'v1-pro', creditMultiplier: 3 }),
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
  state.apiKeyId = null;
  state.serviceAppId = null;
});

describe('the catalogue distinguishes a model from a routing profile by TYPE', () => {
  it('serves the two kinds under two different object values', async () => {
    const { status, body } = await get('/catalogue');
    expect(status).toBe(200);
    expect(body.object).toBe('list');

    const byId = new Map((body.data ?? []).map((e) => [String(e.id), e]));
    expect([...byId.keys()].sort()).toEqual(['profile:lite', 'profile:v1-codea', 'profile:v1-pro']);

    // Two candidates: a policy over two models.
    expect(byId.get('profile:lite')?.object).toBe('routing_profile');
    expect(byId.get('profile:lite')?.profile_id).toBe('profile:lite');
    expect(byId.get('profile:lite')?.selects_among).toBe(2);

    // One candidate: a reference to that model, so it keeps `model` — the value
    // a client already switches on.
    expect(byId.get('profile:v1-codea')?.object).toBe('model');
    expect(byId.get('profile:v1-codea')?.publisher).toBeNull();
    expect(byId.get('profile:v1-codea')?.profile_id).toBeUndefined();
  });

  it('reports capability availability per entry, with unknown distinct from never', async () => {
    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'profile:lite');
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
    expect(byId.get('profile:lite')?.entitlement).toEqual({
      state: 'known',
      access: 'free',
      required_plan: null,
      granted_by: ['free', 'go'],
      products: ['alia'],
      entitled: null,
    });
    expect(byId.get('profile:v1-pro')?.entitlement).toMatchObject({
      access: 'plan',
      required_plan: 'Codea Pro',
      products: ['codea'],
    });
  });

  it('reports entitled once a caller is known, without hiding anything', async () => {
    state.userId = 'user-1';
    const { body } = await get('/catalogue');
    const byId = new Map((body.data ?? []).map((e) => [String(e.id), e]));
    expect((byId.get('profile:lite')?.entitlement as { entitled?: unknown }).entitled).toBe(true);
    expect((byId.get('profile:v1-pro')?.entitlement as { entitled?: unknown }).entitled).toBe(false);
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
    expect((body.data ?? []).map((e) => e.id).sort()).toEqual(['profile:v1-codea', 'profile:v1-pro']);
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
    expect((body.data ?? []).map((e) => e.id)).toEqual(['profile:lite']);
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
  it('carries no deprecation field, because nothing it serves is deprecated', async () => {
    // Entries are keyed by routing profile — what an alias BECOMES — so no
    // entry is inside the compatibility window and there is nothing to mark.
    // The signal moved to where the deprecated identifier still is: the headers
    // and stream event on a request that NAMES an alias.
    const { body } = await get('/catalogue');
    const entries = body.data ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) expect(entry).not.toHaveProperty('deprecation');

    // And no served id is an alias, which is the property that made the field
    // dead in the first place.
    expect(entries.filter((e) => String(e.id).startsWith('alia-'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Availability scopes (#139 workstream 17)                                   */
/* -------------------------------------------------------------------------- */

describe('a route whose availability scope does not admit the caller is withheld', () => {
  /**
   * The whole group is driven from FIXTURE scopes, because no route in this
   * repository declares one — an availability scope is a property of a
   * deployment in the Oxy catalogue and Relay does not exist yet. Written
   * against production data every assertion below would pass vacuously, which
   * is why the first test is about the count that tells the two states apart.
   */
  it('reports how many routes declared a scope, so an unfiltered answer is not mistaken for a filtered one', async () => {
    // Production's state: nothing classified, nothing withheld. On its own this
    // is indistinguishable from a filter that does not exist.
    const unclassified = await get('/catalogue');
    expect(unclassified.body.filters?.availability_scope).toEqual({
      declared_routes: 0,
      withheld_entries: 0,
    });
    // And every entry says so, rather than claiming to be public.
    for (const entry of unclassified.body.data ?? []) {
      expect(entry.availability).toMatchObject({ scope: { state: 'unscoped' } });
    }

    // The other state, reached by classifying one route. The count moves, which
    // is the evidence the number is derived from the data rather than declared.
    state.mappings = {
      lite: [mapping('one', {}, { availabilityScope: 'public_payg' }), mapping('two')],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };
    const classified = await get('/catalogue');
    expect(classified.body.filters?.availability_scope).toEqual({
      declared_routes: 1,
      withheld_entries: 0,
    });
    const lite = (classified.body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.availability).toMatchObject({ scope: { state: 'admitted', values: ['public_payg'] } });
  });

  it('keeps an internal-only entry out of an unauthenticated response, and lets an internal caller have it', async () => {
    // Every route behind this entry is Alia-internal. One unclassified route
    // would keep it reachable, which is the residual `lib/availability-scope.ts`
    // states; here there is none, so the entry is the caller's or it is nobody's.
    state.mappings = {
      lite: [
        mapping('one', {}, { availabilityScope: 'internal_alia' }),
        mapping('two', {}, { availabilityScope: 'internal_alia' }),
      ],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    const anonymous = await get('/catalogue');
    expect(anonymous.status).toBe(200);
    expect((anonymous.body.data ?? []).map((e) => e.id)).toEqual(['alia-v1-codea', 'alia-v1-pro']);
    expect(anonymous.body.filters?.availability_scope).toEqual({
      declared_routes: 2,
      withheld_entries: 1,
    });

    // The positive control. Without it, a filter that withheld EVERY entry —
    // or a fixture that never produced the entry in the first place — would
    // read exactly like the refusal above.
    state.serviceAppId = 'alia-internal';
    const internal = await get('/catalogue');
    expect((internal.body.data ?? []).map((e) => e.id)).toContain('alia-lite');
    expect(internal.body.filters?.availability_scope?.withheld_entries).toBe(0);
    const lite = (internal.body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.availability).toMatchObject({ scope: { state: 'admitted', values: ['internal_alia'] } });
  });

  it('refuses a signed-in user and a developer key, not only an anonymous caller', async () => {
    // The checkbox names *public/user credentials*, and a developer key is the
    // sharpest of the three: `authenticateApiKey` sets `req.user` too, so a
    // resolver that tested the session first would hand every `alia_sk_` key
    // whatever a session may have.
    state.mappings = {
      lite: [mapping('one', {}, { availabilityScope: 'internal_alia' })],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    state.userId = 'user-1';
    const session = await get('/catalogue');
    expect((session.body.data ?? []).map((e) => e.id)).not.toContain('alia-lite');

    state.userId = null;
    state.apiKeyId = 'key-1';
    const developer = await get('/catalogue');
    expect((developer.body.data ?? []).map((e) => e.id)).not.toContain('alia-lite');
    expect(developer.body.filters?.availability_scope?.withheld_entries).toBe(1);
  });

  it('withholds a scope it cannot evaluate rather than admitting it', async () => {
    // `enterprise` needs a contract record Alia has none of and `byok_only`
    // needs a BYOK path Alia does not implement. Admitting either would be
    // assuming the permission this workstream exists to stop assuming, and the
    // reason travels with the withholding so it is not read as a refusal.
    state.mappings = {
      lite: [mapping('one', {}, { availabilityScope: 'enterprise' })],
      'v1-codea': [mapping('three', {}, { availabilityScope: 'byok_only' })],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    state.serviceAppId = 'alia-internal';
    const { body } = await get('/catalogue');
    // Even the most privileged audience: the missing fact is commercial, not a
    // question of credential strength.
    expect((body.data ?? []).map((e) => e.id)).toEqual(['alia-v1-pro']);
    expect(body.filters?.availability_scope).toEqual({ declared_routes: 2, withheld_entries: 2 });
  });

  it('leaves an entry reachable through an unclassified route, and publishes only the admitting scope', async () => {
    // The residual, pinned rather than left to be discovered. An unclassified
    // route is not a scope, so it does not exclude anybody; what it must not do
    // is make the entry look internal-approved to the caller it admitted.
    state.mappings = {
      lite: [mapping('one', {}, { availabilityScope: 'internal_alia' }), mapping('two')],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };
    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite).toBeDefined();
    expect(lite?.availability).toMatchObject({ scope: { state: 'admitted', values: [] } });
    expect(body.filters?.availability_scope).toEqual({ declared_routes: 1, withheld_entries: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Platform capability, and the region that stays delegated (#139 ws5)        */
/* -------------------------------------------------------------------------- */

describe('the catalogue is filtered by what the calling surface can be offered', () => {
  beforeEach(() => {
    // A voice entry alongside the general ones: something a terminal cannot be
    // offered for what it is.
    state.models = [
      model(),
      model({ id: 'alia-v1-voice', name: 'Voice', tier: 'v1-voice', category: 'voice', creditMultiplier: 2 }),
    ];
    state.mappings = { lite: [mapping('one'), mapping('two')], 'v1-voice': [mapping('seven', { audio: true })] };
    state.plans = [plan({ modelIds: ['alia-lite', 'alia-v1-voice'] })];
  });

  it('does not hand an audio entry to a surface that carries no audio', async () => {
    const terminal = await get('/catalogue?surface=terminal');
    expect(terminal.status).toBe(200);
    expect((terminal.body.data ?? []).map((e) => e.id)).toEqual(['alia-lite']);
    expect(terminal.body.filters?.platform_capability).toEqual({
      surface: 'terminal',
      withheld_entries: 1,
    });

    // The positive control: a surface that DOES carry audio receives it, so the
    // empty answer above is the filter working rather than the entry missing.
    const chat = await get('/catalogue?surface=chat');
    expect((chat.body.data ?? []).map((e) => e.id)).toEqual(['alia-lite', 'alia-v1-voice']);
    expect(chat.body.filters?.platform_capability).toEqual({ surface: 'chat', withheld_entries: 0 });
  });

  it('applies no filter when no surface is declared, and says which was declared', async () => {
    const { body } = await get('/catalogue');
    expect((body.data ?? []).map((e) => e.id)).toEqual(['alia-lite', 'alia-v1-voice']);
    expect(body.filters?.platform_capability).toEqual({ surface: null, withheld_entries: 0 });
  });

  it('refuses an unknown surface rather than serving an unfiltered catalogue', async () => {
    const { status, body } = await get('/catalogue?surface=telepathy');
    expect(status).toBe(400);
    expect(body.error?.param).toBe('surface');
    expect(body.error?.code).toBe('invalid_surface');
    // The message names the vocabulary, so a mistyped client can fix itself.
    expect(body.error?.message).toContain('terminal');
    expect(body.data).toBeUndefined();
  });

  it('says region is delegated instead of answering that nothing is restricted', async () => {
    // The stub this epic keeps hitting would be `region: { applied: true,
    // withheld_entries: 0 }`, which no caller could tell from a working filter.
    const { body } = await get('/catalogue');
    expect(body.filters?.region).toEqual({ applied: false, delegated_to: 'relay' });
  });
});

/* -------------------------------------------------------------------------- */
/*  Licence attribution (#139 workstream 17)                                   */
/* -------------------------------------------------------------------------- */

describe('attribution an open-weight licence requires survives to the response', () => {
  it('names the model the licence covers, and counts the routes that carry one', async () => {
    // Nothing carries a licence record today, so the default state is empty and
    // the count says why — the same distinction the scope filter needs.
    const bare = await get('/catalogue');
    expect(bare.body.filters?.attributed_routes).toBe(0);
    for (const entry of bare.body.data ?? []) expect(entry.attribution).toEqual([]);

    state.mappings = {
      lite: [
        mapping('one', {}, { attribution: { license: license(), attributedModel: 'fixturelabs/fixture-70b' } }),
        mapping('two'),
      ],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    const { body } = await get('/catalogue');
    expect(body.filters?.attributed_routes).toBe(1);
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.attribution).toEqual([
      {
        attributed_model: 'fixturelabs/fixture-70b',
        license: {
          license_id: 'fixture-community-1.0',
          display_name: 'Fixture Community License 1.0',
          url: 'https://example.invalid/license',
          requires_attribution: true,
          commercial_use_allowed: true,
          acceptable_use_policy_url: null,
        },
      },
    ]);

    // The point of the whole box: the publisher survives the trip. A sanitiser
    // run over this response would replace it with a marker.
    expect(JSON.stringify(body)).toContain('fixturelabs/fixture-70b');
  });

  it('publishes nothing for a licence that does not require attribution', async () => {
    // The invariant that keeps the catalogue leak census narrow: this field may
    // name a model only because a licence requires the naming. A licence record
    // attached without that requirement is a model identity with no obligation
    // behind it, and is dropped.
    state.mappings = {
      lite: [
        mapping(
          'one',
          {},
          {
            attribution: {
              license: license({ requiresAttribution: false }),
              attributedModel: 'fixturelabs/unattributed-8b',
            },
          },
        ),
      ],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    expect(lite?.attribution).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('unattributed-8b');
    // The route still carried a record, which is what the count reports — so a
    // reader can see the difference between "no licence data" and "licence data
    // that required nothing".
    expect(body.filters?.attributed_routes).toBe(1);
  });

  it('states one obligation once, however many deployments serve the model', async () => {
    state.mappings = {
      lite: [
        mapping('one', {}, { attribution: { license: license(), attributedModel: 'fixturelabs/fixture-70b' } }),
        mapping('one-elsewhere', {}, {
          attribution: { license: license(), attributedModel: 'fixturelabs/fixture-70b' },
        }),
        mapping('two', {}, {
          attribution: { license: license({ licenseId: 'other-1.0' }), attributedModel: 'otherlabs/other-13b' },
        }),
      ],
      'v1-codea': [mapping('three')],
      'v1-pro': [mapping('four'), mapping('five'), mapping('six')],
    };

    const { body } = await get('/catalogue');
    const lite = (body.data ?? []).find((e) => e.id === 'alia-lite');
    const attributed = (lite?.attribution as { attributed_model: string }[]).map((a) => a.attributed_model);
    // Three routes, three licence records, two distinct obligations.
    expect(body.filters?.attributed_routes).toBe(3);
    expect(attributed).toEqual(['fixturelabs/fixture-70b', 'otherlabs/other-13b']);
  });
});
