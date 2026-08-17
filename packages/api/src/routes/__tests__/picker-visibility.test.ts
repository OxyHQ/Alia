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
  body?: { data?: { id: string; chat_visible?: boolean }[] };
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

  const captured: Captured = {};
  const res = {
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
    // Vacuity floor: an empty catalogue annotates nothing and reads like a pass.
    expect(data).toHaveLength(OFFERED.length + HIDDEN.length);

    expect(data.filter((e) => e.chat_visible).map((e) => e.id).sort()).toEqual([...OFFERED].sort());
    expect(data.filter((e) => !e.chat_visible).map((e) => e.id).sort()).toEqual([...HIDDEN].sort());
  });

  it('names NO alia-* identifier anywhere in the catalogue response', async () => {
    // The property #139 asks for, asserted on the bytes rather than on the
    // table that produced them.
    const { ALIA_MODELS } = await import('../../internal/providers/lib/alia-models.js');
    const captured = await get(await import('../catalogue.js'), '/', {});
    const serialized = JSON.stringify(captured.body);
    expect(captured.body?.data).toHaveLength(OFFERED.length + HIDDEN.length);

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
  });
});