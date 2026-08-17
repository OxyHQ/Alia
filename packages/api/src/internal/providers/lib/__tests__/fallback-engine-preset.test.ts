import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PRODUCT half of "cross-model fallback is an explicit product or user
 * policy rather than hidden behavior" (#139 workstream 4, ADR 0003 invariant 3).
 *
 * `lib/routing/presets.ts` describes each preset's `fallbackPolicy` as
 * *"enforced by the fallback engine on every request that selects this
 * preset"*, and until `resolveWithFallback` consulted `getRoutingPreset` that
 * sentence was false: the function had no caller outside tests, so the table
 * was configuration nothing read. A mechanism can be green and inert, and the
 * only way to tell is to assert that the ENTRYPOINT calls it.
 *
 * ## Why the preset table is a fixture here
 *
 * Every shipped preset carries `DEFAULT_FALLBACK_POLICY`, so against the real
 * table "reads the preset" and "ignores the preset and uses the default" give
 * identical answers on every alias — a test over it could not fail. So the
 * TABLE is replaced with one whose entries differ, and everything the
 * assertions are about (which candidates the engine offers, in what order, and
 * what it does when they run out) is the shipped engine. `routing-policy.test.ts`
 * separately pins the real table's values, so this fixture cannot become an
 * excuse for the real one drifting.
 */

const getBestKeyForModel = vi.fn();
const isProviderAvailable = vi.fn();
const getRoutingPreset = vi.fn();

vi.mock('../key-manager', () => ({
  getBestKeyForModel: (...args: unknown[]) => getBestKeyForModel(...args),
  markKeyCreditExhausted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../provider-health', () => ({
  isProviderAvailable: (...args: unknown[]) => isProviderAvailable(...args),
}));

vi.mock('../../../../db/telemetry/fallbackEventRepository.js', () => ({
  recordFallbackEvent: (...args: unknown[]) => {
    recordFallbackEventRow(...args);
    return Promise.resolve();
  },
}));

const recordFallbackEventRow = vi.fn();

vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../../../lib/logger.js', () => ({
  log: { fallback: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../../../lib/routing/presets.js', () => ({
  getRoutingPreset: (id: string) => getRoutingPreset(id) as unknown,
}));

const { resolveWithFallback } = await import('../fallback-engine.js');
const { TIER_MODEL_MAPPINGS, ALIA_MODELS } = await import('../alia-models.js');
const { DEFAULT_FALLBACK_POLICY } = await import('../../../../lib/routing/policy.js');

const ALIAS = 'alia-v1';
const TIER = ALIA_MODELS[ALIAS].tier;

const ranked = () => [...TIER_MODEL_MAPPINGS[TIER]].sort((a, b) => a.priority - b.priority);
const asked = () =>
  getBestKeyForModel.mock.calls.map((call) => `${call[0] as string}:${call[1] as string}`);

/** A preset for `ALIAS` carrying one policy, in the shape the real table uses. */
const preset = (fallbackPolicy: string) => ({
  id: 'profile:fixture',
  aliases: [ALIAS],
  tier: TIER,
  fallbackPolicy,
});

beforeEach(() => {
  vi.clearAllMocks();
  isProviderAvailable.mockResolvedValue(true);
  getBestKeyForModel.mockResolvedValue(null);
  getRoutingPreset.mockReturnValue(null);
});

describe('the fixture can tell the policies apart', () => {
  it('routes over a tier where narrowing is observable', () => {
    // If this tier ever collapsed to one candidate, every assertion below would
    // pass under every policy while measuring nothing.
    const list = ranked();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(new Set(list.map((m) => m.modelId)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('the profile a request selects decides what its fallback may do', () => {
  it('narrows the candidate list to what the preset permits', async () => {
    getRoutingPreset.mockReturnValue(preset('no-fallback'));
    const result = await resolveWithFallback(ALIAS).catch(() => null);

    expect(getRoutingPreset).toHaveBeenCalledWith(ALIAS);
    const top = ranked()[0];
    expect(asked()).toEqual([`${top.provider}:${top.modelId}`]);
    // And the refusal names the policy the PRODUCT set, not one the caller sent.
    expect(result).toBeNull();
  });

  it('walks the whole list when the preset permits it', async () => {
    // The control for the case above. Without it, an engine that always asked
    // for one candidate would pass that test and this file would prove nothing.
    getRoutingPreset.mockReturnValue(preset('cross-model'));
    await resolveWithFallback(ALIAS);
    expect(asked()).toEqual(ranked().map((m) => `${m.provider}:${m.modelId}`));
  });

  it('falls back to the default when no preset claims the identifier', async () => {
    getRoutingPreset.mockReturnValue(null);
    const result = await resolveWithFallback(ALIAS);
    expect(asked()).toEqual(ranked().map((m) => `${m.provider}:${m.modelId}`));
    expect(result.policy).toBe(DEFAULT_FALLBACK_POLICY);
  });
});

describe('the caller outranks the product, and only in the direction they asked for', () => {
  it("uses the request's policy even where the preset is wider", async () => {
    getRoutingPreset.mockReturnValue(preset('cross-model'));
    const result = await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'no-fallback',
    }).catch(() => null);
    const top = ranked()[0];
    expect(asked()).toEqual([`${top.provider}:${top.modelId}`]);
    expect(result).toBeNull();
  });

  it("uses the request's policy even where the preset is narrower", async () => {
    getRoutingPreset.mockReturnValue(preset('no-fallback'));
    await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), { fallbackPolicy: 'cross-model' });
    expect(asked()).toEqual(ranked().map((m) => `${m.provider}:${m.modelId}`));
  });
});

describe('the policy that answered is what gets recorded', () => {
  it("records the PRESET's policy when the caller named none", async () => {
    // Otherwise "why did this response come from that model" is answered with a
    // policy the request never ran under.
    getRoutingPreset.mockReturnValue(preset('no-fallback'));
    await resolveWithFallback(ALIAS).catch(() => null);
    expect(recordFallbackEventRow).toHaveBeenCalled();
    const [, row] = recordFallbackEventRow.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row.fallbackPolicy).toBe('no-fallback');
  });
});
