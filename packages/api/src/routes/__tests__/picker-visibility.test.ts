import { describe, expect, it, vi } from 'vitest';

/**
 * Which entries the product offers in a picker, on both surfaces that answer
 * the question (#139 workstream 4, *"allow Alia product owners to configure
 * which actual models or routing profiles are visible"*).
 *
 * The decision moved out of `internal/providers/lib/alia-models.ts`, where it
 * was a `chatVisible` field on five alias definitions inside the provider
 * mapping table, and into `lib/product-modes.ts` `OFFERED_ALIASES`. Two
 * serializers read it — `GET /catalogue` annotates every entry with it, and
 * `GET /v1/models?chat=true` filters on it — and a configuration nothing reads
 * is configuration in name only, so both are driven here rather than assumed.
 *
 * The expected answers are written out as VALUES, not recomputed from
 * `isAliasVisible`. A test that asked the predicate what the predicate says
 * would pass against any predicate at all, including one that answered `true`
 * for everything.
 */

vi.mock('../../lib/chat-core.js', async () => {
  const { ALIA_MODELS } = await vi.importActual<typeof import('../../internal/providers/lib/alia-models.js')>(
    '../../internal/providers/lib/alia-models.js',
  );
  return {
    getAvailableModels: async () =>
      Object.values(ALIA_MODELS).map((m) => ({ ...m, isAvailable: true, isLegacy: false })),
    getAliaModel: async (id: string) => ALIA_MODELS[id] ?? null,
    getDefaultModelForCategory: async () => null,
  };
});

vi.mock('../../lib/gateway-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../internal/providers/lib/alia-models.js')>(
    '../../internal/providers/lib/alia-models.js',
  );
  return {
    getAvailableModels: async () =>
      Object.values(actual.ALIA_MODELS).map((m) => ({ ...m, isAvailable: true, isLegacy: false })),
    getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
    getPlans: async () => [],
    // Every route reachable, so the availability a model entry reports is not
    // what this file is measuring.
    getAllProviderHealth: async () => [],
  };
});

/**
 * The five the product offers, and the eight it does not. Written out whole,
 * both halves, because "the offered set is right" and "the hidden set is right"
 * are different failures and a list of only the first cannot see the second.
 */
/**
 * The four policies the product advertises, written out as values.
 *
 * Recomputing them from `OFFERED_PROFILES` would ask the list what the list
 * says and pass against any list, including one that grew an `alia-*` entry
 * back. The eight policies it does NOT advertise are written out too, because
 * "the offered set is right" and "the hidden set is right" are different
 * failures and a list of only the first cannot see the second.
 */
const OFFERED = ['profile:lite', 'profile:v1', 'profile:v1-pro', 'profile:v1-pro-max'];
const HIDDEN = [
  'profile:v1-audio',
  'profile:v1-browser',
  'profile:v1-codea',
  'profile:v1-cowork',
  'profile:v1-multimodal',
  'profile:v1-vision',
  'profile:v1-voice',
  'profile:v1-voice-pro',
];

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: { data?: { id: string; object?: string; chat_visible?: boolean }[] };
}

interface RouterLike {
  stack: {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: { handle: (req: unknown, res: unknown) => Promise<void> | void }[];
    };
  }[];
}

/** Drive a router's real `GET` handler, skipping any auth middleware in front of it. */
async function get(module: unknown, routePath: string, query: Record<string, string>): Promise<Captured> {
  const { default: router } = module as { default: RouterLike };
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  const handle = layer?.route?.stack[layer.route.stack.length - 1].handle;
  expect(handle).toBeTypeOf('function');

  const captured: Captured = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Captured['body']) {
      captured.body = body;
      return res;
    },
  };
  await handle?.({ query, params: {} }, res);
  return captured;
}

describe('the product advertises policies, and both surfaces agree', () => {
  it('covers every preset between them, so neither list can hide a change', async () => {
    const { ROUTING_PRESETS } = await import('../../lib/routing/presets.js');
    expect([...OFFERED, ...HIDDEN].sort()).toEqual(ROUTING_PRESETS.map((p) => p.id).sort());
  });

  it('serves GET /catalogue keyed by policy, and annotates the offer per entry', async () => {
    const captured = await get(await import('../catalogue.js'), '/', {});
    const data = captured.body?.data ?? [];
    /**
     * Scoped to the POLICY entries, because the catalogue now also serves
     * individually selectable models and those are a different question with a
     * different answer (`lib/routing/model-selection.ts`). The scoping is
     * floored in both directions: exactly one entry per preset, and a non-empty
     * set of the other kind — so a filter that happened to select everything,
     * or nothing, cannot satisfy the lists below by accident.
     */
    const profiles = data.filter((e) => e.object === 'routing_profile');
    expect(profiles).toHaveLength(OFFERED.length + HIDDEN.length);
    expect(data.filter((e) => e.object === 'model').length).toBeGreaterThan(0);
    expect(new Set(data.map((e) => e.object))).toEqual(new Set(['routing_profile', 'model']));

    expect(profiles.filter((e) => e.chat_visible).map((e) => e.id).sort()).toEqual([...OFFERED].sort());
    expect(profiles.filter((e) => !e.chat_visible).map((e) => e.id).sort()).toEqual([...HIDDEN].sort());

    // A model is never a policy wearing a model's name and never the reverse:
    // the two id namespaces do not overlap, which is what lets a client switch
    // on `object` and a person read either list without decoding a prefix.
    const models = data.filter((e) => e.object === 'model');
    expect(models.filter((e) => e.id.startsWith('profile:'))).toEqual([]);
    expect(profiles.filter((e) => e.id.includes('/'))).toEqual([]);
  });

  it('names NO alia-* identifier anywhere in the catalogue response', async () => {
    // The property #139 asks for, asserted on the bytes rather than on the
    // table that produced them.
    const { ALIA_MODELS } = await import('../../internal/providers/lib/alia-models.js');
    const captured = await get(await import('../catalogue.js'), '/', {});
    const serialized = JSON.stringify(captured.body);
    const data = captured.body?.data ?? [];
    // Two floors rather than one total, so neither kind of entry can vanish and
    // leave this scan reporting a clean response it never looked at.
    expect(data.filter((e) => e.object === 'routing_profile')).toHaveLength(OFFERED.length + HIDDEN.length);
    expect(data.filter((e) => e.object === 'model').length).toBeGreaterThan(0);

    const registered = Object.keys(ALIA_MODELS);
    expect(registered).toHaveLength(13);
    expect(registered.filter((alias) => serialized.includes(alias))).toEqual([]);

    // The scan's positive control: it CAN see one of these when present.
    expect(JSON.stringify({ planted: registered[0] })).toContain(registered[0]);
  });

  it('serves GET /v1/models as an empty list, because Alia publishes no models', async () => {
    const captured = await get(await import('../v1/models.js'), '/', {});
    expect(captured.status).toBeUndefined();
    expect(captured.body?.data).toEqual([]);

    // …and says where the catalogue went, since an empty list is otherwise
    // indistinguishable from an outage.
    expect(captured.headers.Link).toBe('</catalogue>; rel="alternate"');
    expect(captured.headers.Deprecation).toBeUndefined();
  });
});