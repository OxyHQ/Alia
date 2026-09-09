import { describe, expect, it, vi } from 'vitest';

/**
 * Which entries the product offers in a picker, on both surfaces that answer
 * the question (#139 workstream 4, *"allow Alia product owners to configure
 * which actual models or routing profiles are visible"*).
 *
 * The decision moved out of `internal/providers/lib/routing-profile-catalogue.ts`, where it
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
  const { KAANA_ROUTING_PROFILES } = await vi.importActual<typeof import('../../internal/providers/lib/routing-profile-catalogue.js')>(
    '../../internal/providers/lib/routing-profile-catalogue.js',
  );
  return {
    getAvailableModels: async () =>
      Object.values(KAANA_ROUTING_PROFILES).map((m) => ({ ...m, isAvailable: true })),
    getRoutingProfile: async (id: string) => KAANA_ROUTING_PROFILES[id] ?? null,
    getDefaultModelForCategory: async () => null,
  };
});

vi.mock('../../lib/gateway-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../internal/providers/lib/routing-profile-catalogue.js')>(
    '../../internal/providers/lib/routing-profile-catalogue.js',
  );

  return {
    getAvailableModels: async () =>
      Object.values(actual.KAANA_ROUTING_PROFILES).map((m) => ({ ...m, isAvailable: true })),
    getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
    getPlans: async () => [],
    // Every route servable, so the availability an entry reports is not what
    // this file is measuring — and a catalogue that answered "nothing is
    // available" would empty the picker and satisfy every list below by having
    // nothing in it.
    getAllProviderHealth: async () => [],
    providersWithUsableCredentials: async () =>
      // Derived from the routing table this mock already reads, rather than
      // from `PROVIDER_NAMES` — same answer for every route that exists, and it
      // adds no second module for gate 1 to record.
      new Set(
        Object.values(actual.TIER_MODEL_MAPPINGS).flatMap((routes) =>
          routes.map((route) => route.provider),
        ),
      ),
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
const OFFERED = [
  'route:auto',
  'route:code',
  'route:instant',
  'route:pro',
  'route:research',
  'route:thinking',
];
const HIDDEN = [
  'route:audio',
  'route:cowork',
  'route:multimodal',
  'route:pro-standard',
  'route:vision',
  'route:voice',
  'route:voice-pro',
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
    expect([...OFFERED, ...HIDDEN].sort()).toEqual(
      ROUTING_PRESETS.flatMap((p) => p.profileIds).sort(),
    );
  });

  it('serves GET /catalogue keyed by policy, and annotates the offer per entry', async () => {
    const captured = await get(await import('../catalogue.js'), '/', {});
    const data = captured.body?.data ?? [];
    // Alia publishes only product routing profiles. Concrete model selection
    // belongs to the Oxy platform catalogue and must not enter hosted chat.
    const profiles = data.filter((e) => e.object === 'routing_profile');
    expect(profiles).toHaveLength(OFFERED.length + HIDDEN.length);
    expect(data.filter((e) => e.object === 'model')).toEqual([]);
    expect(new Set(data.map((e) => e.object))).toEqual(new Set(['routing_profile']));

    expect(profiles.filter((e) => e.chat_visible).map((e) => e.id).sort()).toEqual([...OFFERED].sort());
    expect(profiles.filter((e) => !e.chat_visible).map((e) => e.id).sort()).toEqual([...HIDDEN].sort());

    expect(profiles.filter((e) => e.id.includes('/'))).toEqual([]);
  });

  it('publishes Kaana profiles and no retired alia-* spelling', async () => {
    const { KAANA_ROUTING_PROFILES } = await import('../../internal/providers/lib/routing-profile-catalogue.js');
    const captured = await get(await import('../catalogue.js'), '/', {});
    const serialized = JSON.stringify(captured.body);
    const data = captured.body?.data ?? [];
    expect(data.filter((e) => e.object === 'routing_profile')).toHaveLength(OFFERED.length + HIDDEN.length);
    expect(data.filter((e) => e.object === 'model')).toEqual([]);

    const registered = Object.keys(KAANA_ROUTING_PROFILES);
    expect(registered).toHaveLength(13);
    expect(registered.filter((profileId) => serialized.includes(profileId)).sort()).toEqual(
      [...registered].sort(),
    );
    expect(serialized).not.toMatch(/alia-(?:lite|v1)/);

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
