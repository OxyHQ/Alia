import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fallback engine's routing behaviour (#139 workstream 14, ADR 0003
 * invariants 2 and 3).
 *
 * ## This drives the real `resolveWithFallback`
 *
 * Nothing below re-implements candidate selection or the retry ladder. The only
 * things replaced are the two I/O edges the engine consults — the key manager
 * and the circuit breaker — plus the telemetry writer, because a unit suite has
 * no Postgres. Everything the assertions are about (which candidates are
 * offered, in which order, and what happens when they run out) is the shipped
 * code.
 *
 * `getBestKeyForModel` is the observation point: it is called exactly once per
 * candidate the engine is willing to try, with that candidate's provider and
 * upstream model id. So the set of models the engine ASKED FOR is directly
 * readable from the mock's call log, which is the property every policy test
 * here is really about.
 */

const getBestKeyForModel = vi.fn();
const isProviderAvailable = vi.fn();
const recordFallbackEventRow = vi.fn();

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

vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../../../lib/logger.js', () => ({
  log: { fallback: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

const { resolveWithFallback } = await import('../fallback-engine.js');
const { TIER_MODEL_MAPPINGS, ALIA_MODELS } = await import('../alia-models.js');
const { UnregisteredModelError, FallbackNotPermittedError, DEFAULT_FALLBACK_POLICY } = await import(
  '../../../../lib/routing/policy.js'
);

/** The tier every case below routes over, and the one this file asserts against. */
const ALIAS = 'alia-v1';
const TIER = ALIA_MODELS[ALIAS].tier;

/** Candidates in the order the engine ranks them, priority ascending. */
const rankedCandidates = () =>
  [...TIER_MODEL_MAPPINGS[TIER]].sort((a, b) => a.priority - b.priority);

/** Every `(provider, modelId)` the engine asked a key for, in call order. */
const asked = () =>
  getBestKeyForModel.mock.calls.map((call) => ({ provider: call[0] as string, modelId: call[1] as string }));

const aKey = { keyId: 'k1', provider: 'p', modelId: 'm', key: 'secret' };

beforeEach(() => {
  vi.clearAllMocks();
  isProviderAvailable.mockResolvedValue(true);
  getBestKeyForModel.mockResolvedValue(null);
});

describe('the fixture is not vacuous', () => {
  it('routes over a tier with several candidates spanning several providers', () => {
    // Every policy assertion below is a statement about a SUBSET of this list.
    // If the tier ever collapsed to one candidate, `no-fallback`,
    // `same-model-only` and `cross-model` would become indistinguishable and
    // the whole file would pass while measuring nothing.
    const ranked = rankedCandidates();
    expect(ranked.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ranked.map((m) => m.provider)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(ranked.map((m) => m.modelId)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('an unregistered identifier is refused, not rewritten (ADR 0003 invariant 2)', () => {
  it('throws instead of resolving, and never asks for a key', async () => {
    await expect(resolveWithFallback('alia-flash')).rejects.toBeInstanceOf(UnregisteredModelError);
    // The old behaviour was `isAliaModel(id) ? id : 'alia-v1'`, which would have
    // walked `alia-v1`'s candidate list. Zero calls is what proves it does not.
    expect(getBestKeyForModel).not.toHaveBeenCalled();
    expect(recordFallbackEventRow).not.toHaveBeenCalled();
  });

  it('reports the identifier the caller sent, not a substitute', async () => {
    // The precise failure ADR 0003 names: answering from different weights while
    // reporting the requested name. Here the requested name is all that comes
    // back, and nothing was answered.
    const error = await resolveWithFallback('gpt-4o').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnregisteredModelError);
    expect((error as InstanceType<typeof UnregisteredModelError>).requested).toBe('gpt-4o');
  });

  it('lists every registered identifier so the message is actionable', async () => {
    const error = (await resolveWithFallback('nope').catch((e: unknown) => e)) as InstanceType<
      typeof UnregisteredModelError
    >;
    expect([...error.available].sort()).toEqual(Object.keys(ALIA_MODELS).sort());
  });

  it('does not refuse a registered identifier', async () => {
    // The negative control. Without it, an engine that threw on EVERYTHING
    // would pass all three cases above.
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(ALIAS);
    expect(result.resolved?.aliasModelId).toBe(ALIAS);
  });
});

describe('the default policy walks the same candidates it always did', () => {
  it('resolves on the top-ranked candidate when it has a key', async () => {
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(ALIAS);
    const top = rankedCandidates()[0];
    expect(asked()).toEqual([{ provider: top.provider, modelId: top.modelId }]);
    expect(result.resolved?.isFallback).toBe(false);
    expect(result.policy).toBe(DEFAULT_FALLBACK_POLICY);
  });

  it('walks the whole ranked list across publishers when no key answers', async () => {
    const result = await resolveWithFallback(ALIAS);
    const ranked = rankedCandidates();
    // Every candidate, in priority order — cross-model substitution, which is
    // what this engine has always done and what this change preserves.
    expect(asked().map((a) => `${a.provider}:${a.modelId}`)).toEqual(
      ranked.map((m) => `${m.provider}:${m.modelId}`),
    );
    // Exhaustion under the default is still `null`, not a throw. Every existing
    // caller turns this into its own "no models available" response.
    expect(result.resolved).toBeNull();
  });

  it('is what an absent policy selects', async () => {
    getBestKeyForModel.mockResolvedValue(aKey);
    const implicit = await resolveWithFallback(ALIAS);
    vi.clearAllMocks();
    isProviderAvailable.mockResolvedValue(true);
    getBestKeyForModel.mockResolvedValue(aKey);
    const explicit = await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'cross-model',
    });
    expect(implicit.policy).toBe(explicit.policy);
    expect(implicit.resolved?.modelId).toBe(explicit.resolved?.modelId);
  });
});

describe('no-fallback stops at the top-ranked candidate', () => {
  it('asks for exactly one model', async () => {
    await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), { fallbackPolicy: 'no-fallback' }).catch(
      () => null,
    );
    const top = rankedCandidates()[0];
    expect(asked()).toEqual([{ provider: top.provider, modelId: top.modelId }]);
  });

  it('reports the refusal rather than answering from a substitute', async () => {
    const error = await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'no-fallback',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FallbackNotPermittedError);
    expect((error as InstanceType<typeof FallbackNotPermittedError>).policy).toBe('no-fallback');
    expect((error as InstanceType<typeof FallbackNotPermittedError>).userMessage).toContain(ALIAS);
  });

  it('still succeeds when the top-ranked candidate has a key', async () => {
    // The negative control for the two above: `no-fallback` must not mean
    // "always fail", which is what a policy implemented as an early return
    // would look like from the outside.
    getBestKeyForModel.mockResolvedValue(aKey);
    const result = await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'no-fallback',
    });
    expect(result.resolved).not.toBeNull();
    expect(result.policy).toBe('no-fallback');
  });
});

describe('same-model-only permits other deployments of one model (ADR 0003 invariant 4)', () => {
  it('asks only for the top-ranked model, and for every provider serving it', async () => {
    await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'same-model-only',
    }).catch(() => null);

    const ranked = rankedCandidates();
    const sameModel = ranked.filter((m) => m.modelId === ranked[0].modelId);
    expect(asked()).toEqual(sameModel.map((m) => ({ provider: m.provider, modelId: m.modelId })));
    // One upstream model, never two. This is the invariant, stated directly.
    expect(new Set(asked().map((a) => a.modelId))).toEqual(new Set([ranked[0].modelId]));
  });

  it('offers strictly fewer candidates than cross-model on this tier', () => {
    // Otherwise the case above is satisfied by a tier where the narrowing
    // happens to be a no-op, and the whole policy could be a no-op with it.
    const ranked = rankedCandidates();
    const sameModel = ranked.filter((m) => m.modelId === ranked[0].modelId);
    expect(sameModel.length).toBeLessThan(ranked.length);
  });

  it('reports the refusal when no deployment of that model answers', async () => {
    const error = await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), {
      fallbackPolicy: 'same-model-only',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FallbackNotPermittedError);
    expect((error as InstanceType<typeof FallbackNotPermittedError>).policy).toBe('same-model-only');
  });
});

describe('the routing policy travels with the telemetry row', () => {
  it('records the policy and its version on a failed resolution', async () => {
    await resolveWithFallback(ALIAS);
    expect(recordFallbackEventRow).toHaveBeenCalled();
    const [, row] = recordFallbackEventRow.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row.fallbackPolicy).toBe(DEFAULT_FALLBACK_POLICY);
    expect(typeof row.routingPolicyVersion).toBe('number');
  });

  it('records the alias the caller sent, never a rewritten one', async () => {
    // The analytics half of invariant 2. Before this change a row for an
    // unregistered request would have said `alia-v1`; now no row exists at all,
    // and a registered request records its own name.
    await resolveWithFallback(ALIAS);
    const [, row] = recordFallbackEventRow.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row.aliasModel).toBe(ALIAS);
  });

  it('carries the caller’s policy, not the default, when one was chosen', async () => {
    await resolveWithFallback(ALIAS, 1000, new Set(), new Set(), { fallbackPolicy: 'no-fallback' }).catch(
      () => null,
    );
    const [, row] = recordFallbackEventRow.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row.fallbackPolicy).toBe('no-fallback');
  });
});
