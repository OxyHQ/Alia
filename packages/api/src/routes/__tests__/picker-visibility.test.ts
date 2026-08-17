import { describe, expect, it, vi } from 'vitest';

/**
 * Which entries the product offers in a picker, on both surfaces that answer
 * the question (#139 workstream 4, *"allow Alia product owners to configure
 * which actual models or routing profiles are visible"*).
 *
 * The decision moved out of `internal/providers/lib/alia-models.ts`, where it
 * was a `chatVisible` field on five alias definitions inside the provider
 * mapping table, and into `lib/product-modes.ts` `VISIBLE_PROFILES`. Two
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
const OFFERED = ['alia-lite', 'alia-v1', 'alia-v1-pro', 'alia-v1-pro-max', 'alia-v1-thinking'];
const HIDDEN = [
  'alia-v1-audio',
  'alia-v1-browser',
  'alia-v1-codea',
  'alia-v1-cowork',
  'alia-v1-multimodal',
  'alia-v1-vision',
  'alia-v1-voice',
  'alia-v1-voice-pro',
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

/** Drive a router's real `GET /` handler, skipping any auth middleware in front of it. */
async function get(module: unknown, query: Record<string, string>): Promise<Captured> {
  const { default: router } = module as { default: RouterLike };
  const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods.get);
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
  await handle?.({ query }, res);
  return captured;
}

describe('the product decides what a picker offers, and both surfaces obey it', () => {
  it('covers every registered identifier between them, so neither list can hide a change', async () => {
    const { ALIA_MODELS } = await import('../../internal/providers/lib/alia-models.js');
    expect([...OFFERED, ...HIDDEN].sort()).toEqual(Object.keys(ALIA_MODELS).sort());
  });

  it('annotates GET /catalogue with the offer, per entry', async () => {
    const captured = await get(await import('../catalogue.js'), {});
    const data = captured.body?.data ?? [];
    // Vacuity floor: an empty catalogue annotates nothing and reads like a pass.
    expect(data).toHaveLength(OFFERED.length + HIDDEN.length);

    expect(data.filter((e) => e.chat_visible).map((e) => e.id).sort()).toEqual([...OFFERED].sort());
    expect(data.filter((e) => !e.chat_visible).map((e) => e.id).sort()).toEqual([...HIDDEN].sort());
  });

  it('filters GET /v1/models?chat=true down to the same five', async () => {
    const captured = await get(await import('../v1/models.js'), { chat: 'true' });
    expect(captured.body?.data?.map((e) => e.id).sort()).toEqual([...OFFERED].sort());
  });

  it('and the unfiltered list is strictly larger, or the filter is not filtering', async () => {
    // The control. Without it, a handler that returned five entries whatever it
    // was asked would satisfy the case above.
    const captured = await get(await import('../v1/models.js'), {});
    expect(captured.body?.data?.map((e) => e.id).sort()).toEqual([...OFFERED, ...HIDDEN].sort());
  });
});
