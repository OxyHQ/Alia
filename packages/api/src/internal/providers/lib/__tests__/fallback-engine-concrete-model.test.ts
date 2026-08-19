import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A selected concrete model stays concrete through the request path
 * (#139 workstream 4; ADR 0003 invariants 2 and 4).
 *
 * ## What "concrete" means here is not this file's opinion
 *
 * `lib/catalogue.ts` decides it, by fan-out: an identifier resolving to ONE
 * model is a reference to that model, one selecting among several is a policy.
 * So the same discriminator drives both halves below — `buildEntry` is asked
 * what the catalogue would SERVE for a candidate set, and `resolveWithFallback`
 * is asked what the engine actually DOES with it. The property is that they
 * cannot disagree: whatever the catalogue calls `object: "model"`, the engine
 * answers from that model or from nothing, under every fallback policy.
 *
 * ## Why the routing table is a fixture
 *
 * No tier in this repository resolves to a single model today — the migration
 * map measured all thirteen aliases and every one fans out to at least two
 * models across at least two providers. A test written against the live table
 * would therefore assert the concrete-model property over an empty set and
 * pass without ever exercising it. The fixture supplies one identifier of each
 * kind; the engine, the policy narrowing and the catalogue's classifier are all
 * the shipped code.
 *
 * The multi-model identifier is not decoration: it is the control that proves
 * this file can SEE the engine crossing from one model to another, which is the
 * only thing that makes the concrete case's silence meaningful.
 */

const getBestKeyForModel = vi.fn();
const isProviderAvailable = vi.fn();

const CONCRETE = 'fixture-concrete';
const PROFILE = 'fixture-profile';
const SOLO_TIER = 'fixture-solo';
const MULTI_TIER = 'fixture-multi';
const SOLO_MODEL = 'solo-model';

const capabilities = {
  vision: false,
  audio: false,
  video: false,
  voice: false,
  tools: true,
  codeExecution: false,
  webSearch: false,
  computerUse: false,
  streaming: true,
  systemPrompts: true,
  functionCalling: true,
  promptCaching: false,
  maxContextTokens: 128000,
  maxOutputTokens: 8192,
};

const mapping = (provider: string, modelId: string, priority: number) => ({
  provider,
  // A publisher that is NOT the provider, deliberately: these fixtures exist to
  // separate a model's identity from the deployments serving it, and three
  // deployments of one model is exactly the case where copying the provider in
  // would fabricate three publishers for one piece of work.
  publisher: 'fixture-publisher',
  // In this fixture the deployment id IS the model name — the solo tier is one
  // model on three deployments and the multi tier is two models on two. That is
  // what makes it a control for `same-model-only`, which now compares the
  // identity pair rather than the operator's id: without a distinct `model` on
  // each of `model-a` and `model-b` they would share one identity and the
  // policy would admit both, which is exactly what this file asserts it cannot.
  model: modelId,
  modelId,
  priority,
  qualityScore: 90,
  pricingTier: 'paid' as const,
  capabilities,
});

/**
 * One model on three deployments, and two models on two. The first is the
 * concrete reference; the second is the policy.
 */
const FIXTURE_TIER_MAPPINGS = {
  [SOLO_TIER]: [
    mapping('deployment-one', SOLO_MODEL, 1),
    mapping('deployment-two', SOLO_MODEL, 2),
    mapping('deployment-three', SOLO_MODEL, 3),
  ],
  [MULTI_TIER]: [mapping('deployment-one', 'model-a', 1), mapping('deployment-two', 'model-b', 2)],
};

const FIXTURE_MODELS = {
  [CONCRETE]: {
    id: CONCRETE,
    name: 'Fixture Concrete',
    tier: SOLO_TIER,
    description: 'One model, several deployments',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
  },
  [PROFILE]: {
    id: PROFILE,
    name: 'Fixture Profile',
    tier: MULTI_TIER,
    description: 'Several models',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
  },
};

vi.mock('../alia-models', () => ({
  ALIA_MODELS: FIXTURE_MODELS,
  TIER_MODEL_MAPPINGS: FIXTURE_TIER_MAPPINGS,
  isAliaModel: (id: string) => id in FIXTURE_MODELS,
  getAliaModel: (id: string) => (FIXTURE_MODELS as Record<string, unknown>)[id] ?? null,
}));

vi.mock('../key-manager', () => ({
  getBestKeyForModel: (...args: unknown[]) => getBestKeyForModel(...args),
  markKeyCreditExhausted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../provider-health', () => ({
  isProviderAvailable: (...args: unknown[]) => isProviderAvailable(...args),
}));

vi.mock('../../../../db/telemetry/fallbackEventRepository.js', () => ({
  recordFallbackEvent: () => Promise.resolve(),
}));

vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));

// `lib/catalogue.ts` pulls in `gateway-client`, which logs on import under a
// different channel, so the stub covers every channel rather than one.
vi.mock('../../../../lib/logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});

const { resolveWithFallback } = await import('../fallback-engine.js');
const { buildEntry } = await import('../../../../lib/catalogue.js');
const { FALLBACK_POLICIES } = await import('../../../../lib/routing/policy.js');

const askedModels = () => new Set(getBestKeyForModel.mock.calls.map((call) => call[1] as string));

const aKey = { keyId: 'k1', provider: 'p', modelId: 'm', key: 'secret' };

/** What `GET /catalogue` would serve for a tier, computed by the shipped classifier. */
const servedKind = (tier: keyof typeof FIXTURE_TIER_MAPPINGS): string =>
  buildEntry(
    {
      id: 'irrelevant',
      offeredProfileId: 'irrelevant',
      name: 'Irrelevant',
      description: '',
      category: 'general',
      tier,
      creditMultiplier: 1,
      isLegacy: false,
    },
    // No availability scope and no licence record, which is what every route in
    // this repository carries — the classifier this asserts on reads neither.
    FIXTURE_TIER_MAPPINGS[tier].map((m) => ({
      modelId: m.modelId,
      provider: m.provider,
      publisher: m.publisher,
      model: m.model,
      // Servable, because this file measures CLASSIFICATION — how many models a
      // candidate set holds — and an unservable set classifies identically.
      // Whether a route can answer is measured in `catalogue.test.ts`.
      servable: true,
      capabilities: {},
      availabilityScope: null,
      attribution: null,
    })),
    { state: 'unknown' },
    'public',
  ).kind;

beforeEach(() => {
  vi.clearAllMocks();
  isProviderAvailable.mockResolvedValue(true);
  getBestKeyForModel.mockResolvedValue(null);
});

describe('the fixture holds one identifier of each kind, by the catalogue’s own classifier', () => {
  it('classifies the single-model tier as a model and the other as a routing profile', () => {
    expect(servedKind(SOLO_TIER)).toBe('model');
    expect(servedKind(MULTI_TIER)).toBe('routing_profile');
  });

  it('gives the concrete identifier several deployments, so exhaustion is reachable', () => {
    // Otherwise "never leaves the model" is satisfied by there being nowhere to
    // go, and the engine's narrowing is never exercised at all.
    expect(FIXTURE_TIER_MAPPINGS[SOLO_TIER].length).toBeGreaterThan(1);
    expect(new Set(FIXTURE_TIER_MAPPINGS[SOLO_TIER].map((m) => m.modelId)).size).toBe(1);
  });
});

describe('a concrete model stays concrete, under every policy', () => {
  it.each(FALLBACK_POLICIES)('answers from that model or from nothing under %s', async (policy) => {
    getBestKeyForModel.mockResolvedValue(null);
    await resolveWithFallback(CONCRETE, 1000, new Set(), new Set(), { fallbackPolicy: policy }).catch(
      () => null,
    );
    // Every deployment it tried served the one model. A cross-tier widen, a
    // "try the general tier as a last resort" branch or a substituted default
    // would all show up here as a second model id.
    expect(askedModels()).toEqual(new Set([SOLO_MODEL]));
    expect(askedModels().size).toBeGreaterThan(0);
  });

  it('reports the identifier the caller sent and the model it resolved', async () => {
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(CONCRETE);
    expect(result.resolved?.aliasModelId).toBe(CONCRETE);
    expect(result.resolved?.modelId).toBe(SOLO_MODEL);
  });

  it('changes deployment but never the model when the first one has no key', async () => {
    // ADR 0003 invariant 4: which deployment answers is not something a caller
    // can observe about model identity, so moving between them is permitted
    // and moving between models is not.
    getBestKeyForModel.mockResolvedValueOnce(null).mockResolvedValue(aKey);
    const result = await resolveWithFallback(CONCRETE);
    expect(result.resolved?.modelId).toBe(SOLO_MODEL);
    expect(result.resolved?.provider).toBe('deployment-two');
    expect(result.usedFallback).toBe(true);
  });
});

describe('the control: this file can see the engine crossing between models', () => {
  it('walks two different models for the routing profile', async () => {
    // Without this, the concrete case above would read exactly the same if the
    // engine never asked for anything at all.
    await resolveWithFallback(PROFILE);
    expect(askedModels()).toEqual(new Set(['model-a', 'model-b']));
  });

  it('and stops at one of them when the request forbids crossing', async () => {
    await resolveWithFallback(PROFILE, 1000, new Set(), new Set(), {
      fallbackPolicy: 'same-model-only',
    }).catch(() => null);
    expect(askedModels()).toEqual(new Set(['model-a']));
  });
});

describe('naming a model pins the request to it, inside a tier that holds several', () => {
  /**
   * The other half of the same invariant, and the one the picker depends on.
   *
   * Above, an identifier that resolves to ONE model stays on it. Here the
   * identifier resolves to a tier holding TWO, the caller names one of them,
   * and the engine must answer from that one — which is a property the tests
   * above cannot see at all, because their tier has nothing else to drift to.
   */
  const PUBLISHER = 'fixture-publisher';

  it('walks only the named model, and it is not the tier\u2019s default', async () => {
    await resolveWithFallback(PROFILE, 1000, new Set(), new Set(), {
      pinnedModel: { publisher: PUBLISHER, model: 'model-b' },
    }).catch(() => null);
    expect(askedModels()).toEqual(new Set(['model-b']));

    // The control that makes the assertion above mean something: `model-b` is
    // NOT what the tier resolves to when nobody names anything, so a pin that
    // did nothing would have produced `model-a` first.
    vi.clearAllMocks();
    isProviderAvailable.mockResolvedValue(true);
    getBestKeyForModel.mockResolvedValue(null);
    await resolveWithFallback(PROFILE).catch(() => null);
    expect([...askedModels()][0]).toBe('model-a');
  });

  it('resolves to the named model rather than the higher-priority one', async () => {
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(PROFILE, 1000, new Set(), new Set(), {
      pinnedModel: { publisher: PUBLISHER, model: 'model-b' },
    });
    expect(result.resolved?.modelId).toBe('model-b');
    // The alias is still what the rest of the request path reads for price,
    // plan and prompt — the pin narrows routing, it does not replace the tier.
    expect(result.resolved?.aliasModelId).toBe(PROFILE);
  });

  it('records the policy a pinned request actually ran under', async () => {
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(PROFILE, 1000, new Set(), new Set(), {
      pinnedModel: { publisher: PUBLISHER, model: 'model-b' },
    });
    // Not `cross-model`, which is both the preset's policy and the default: a
    // pinned request cannot substitute, and the telemetry row and the
    // exhaustion message both read this value.
    expect(result.policy).toBe('same-model-only');
    expect(FALLBACK_POLICIES).toContain(result.policy);
  });

  it('cannot be widened back to the tier by asking for cross-model', async () => {
    // The pin narrows BEFORE the policy applies, so the widest policy there is
    // still cannot reach a model the caller did not name.
    await resolveWithFallback(PROFILE, 1000, new Set(), new Set(), {
      fallbackPolicy: 'cross-model',
      pinnedModel: { publisher: PUBLISHER, model: 'model-b' },
    }).catch(() => null);
    expect(askedModels()).toEqual(new Set(['model-b']));
  });

  it('refuses by NAME when every deployment of the named model is exhausted', async () => {
    getBestKeyForModel.mockResolvedValue(null);
    const failure = await resolveWithFallback(CONCRETE, 1000, new Set(), new Set(), {
      pinnedModel: { publisher: PUBLISHER, model: SOLO_MODEL },
    }).then(
      () => null,
      (err: unknown) => err,
    );
    // A pinned request that runs out is a product refusal naming the model the
    // caller asked for, not a 503 naming an alias they have never seen.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`${PUBLISHER}/${SOLO_MODEL}`);
    expect((failure as Error).message).not.toContain(CONCRETE);
  });
});
