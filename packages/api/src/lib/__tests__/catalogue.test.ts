/**
 * The catalogue derivation (ADR 0003, epic #139 workstream 5).
 *
 * Everything here drives the REAL functions from `lib/catalogue.ts` with
 * fixtures. The fixtures exist to reach states the live routing table does not
 * currently produce — chiefly a candidate set of size one, which is the only
 * way to observe the `model` branch of ADR 0003 invariant 1 and therefore the
 * only way the invariant is measured in both directions rather than in the one
 * direction today's data happens to take.
 *
 * ## What each group would report if the thing it measures were absent
 *
 * The classification group would report the wrong `kind`, which is the whole
 * failure. The capability group's hazard is subtler: a derivation that answered
 * `never` for everything would satisfy "no entry claims a capability it lacks"
 * and read as clean, so every state is asserted positively, and the
 * `unknown`-vs-`never` distinction — the one that decides whether a picker greys
 * out a working feature — has its own case in both directions.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_FALLBACK_POLICY } from '../routing/policy.js';
import type { CallerAudience } from '../availability-scope.js';
import {
  CAPABILITY_POLICY,
  buildEntry,
  deriveCapabilities,
  resolveEntitlement,
  type Candidate,
  type CatalogueEntitlement,
  type CatalogueSource,
  type PlanGrant,
} from '../catalogue.js';

/**
 * The weakest audience, so nothing in this file is measured from a position of
 * privilege. The scope decision itself is measured in
 * `availability-scope.test.ts` across all four.
 */
const PUBLIC: CallerAudience = 'public';

const KNOWN: CatalogueEntitlement = {
  state: 'known',
  access: 'free',
  requiredPlan: null,
  grantedBy: ['free'],
  products: ['alia'],
  entitled: true,
};

function source(overrides: Partial<CatalogueSource> = {}): CatalogueSource {
  return {
    id: 'alia-test',
    name: 'Alia Test',
    description: 'A fixture',
    category: 'general',
    tier: 'test-tier',
    emoji: '🧪',
    creditMultiplier: 1,
    isAvailable: true,
    isLegacy: false,
    ...overrides,
  };
}

function candidate(
  modelId: string,
  capabilities: Record<string, unknown>,
  route: Partial<Pick<Candidate, 'availabilityScope' | 'attribution' | 'publisher'>> = {},
): Candidate {
  // `availabilityScope` and `attribution` default to `null`, which is what
  // every route in this repository carries: both belong to a deployment in
  // Relay's catalogue and nothing here has one. A fixture that wants either
  // says so, which is the only way the consumption is measurable today.
  //
  // `publisher` is the opposite case and so defaults the other way: the local
  // routing table attributes all 115 mappings, so an unattributed route is the
  // EXCEPTION a fixture has to ask for, and defaulting it to `null` here would
  // make every provenance assertion in this file describe a table that does not
  // exist.
  return {
    modelId,
    publisher: 'openai',
    capabilities,
    availabilityScope: null,
    attribution: null,
    ...route,
  };
}

/** A capability record with every field this repository actually records. */
function caps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tools: true,
    vision: false,
    audio: false,
    video: false,
    voice: false,
    streaming: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
    ...overrides,
  };
}

describe('ADR 0003 invariant 1: type follows fan-out, in both directions', () => {
  it('serializes a single-model identifier as a model, never as a profile', () => {
    const entry = buildEntry(source(), [candidate('one-model', caps())], KNOWN, PUBLIC);
    expect(entry.kind).toBe('model');
    // The two halves of `<publisher>/<model>`, carried apart from whoever serves
    // it. Null here because this repository holds no publisher attribution —
    // the routing table stores a bare provider model id with no publisher
    // segment. Filling them from `modelId` is the mistake this asserts against.
    if (entry.kind !== 'model') throw new Error('unreachable');
    expect(entry.publisher).toBeNull();
    expect(entry.model).toBeNull();
    expect(Object.keys(entry)).not.toContain('profileId');
  });

  it('serializes a multi-model identifier as a routing profile, never as a model', () => {
    const entry = buildEntry(
      source({ tier: 'lite' }),
      [candidate('a', caps()), candidate('b', caps()), candidate('c', caps())],
      KNOWN,
      PUBLIC,
    );
    expect(entry.kind).toBe('routing_profile');
    if (entry.kind !== 'routing_profile') throw new Error('unreachable');
    expect(entry.selectsAmong).toBe(3);
    expect(entry.profileId).toBe('profile:lite');
    // ADR 0003's routing-profile identity rule: never in <publisher>/<model>
    // form. One careless rename away at any time.
    expect(entry.profileId).not.toContain('/');
  });

  it('counts DEPLOYMENTS of one model as one model, not as a policy', () => {
    // ADR 0003: several deployments may serve one model, and doing so does not
    // change the model. Two providers offering the same model id is exactly
    // that case, and counting mappings instead of models would misclassify it
    // as a policy — inventing a routing decision that is not one.
    const entry = buildEntry(source(), [candidate('same', caps()), candidate('same', caps())], KNOWN, PUBLIC);
    expect(entry.kind).toBe('model');
  });

  it('treats an emptied candidate list as a profile selecting among nothing', () => {
    const entry = buildEntry(source({ tier: 'ghost' }), [], KNOWN, PUBLIC);
    expect(entry.kind).toBe('routing_profile');
    if (entry.kind !== 'routing_profile') throw new Error('unreachable');
    expect(entry.selectsAmong).toBe(0);
  });
});

describe('the capability figures say which routing policy they describe', () => {
  it('describes the candidate set cross-model walks, and says so on every entry', () => {
    // The figures are computed over the WHOLE ranked list, which is exactly what
    // `candidatesUnderPolicy` returns for `cross-model` and for no other policy:
    // `no-fallback` walks `[sortedMappings[0]]`, `same-model-only` only the
    // top-ranked model's deployments. Under either, `sometimes` below would be a
    // deterministic answer instead.
    expect(CAPABILITY_POLICY).toBe('cross-model');
    const derived = deriveCapabilities([
      candidate('a', caps({ vision: true })),
      candidate('b', caps({ vision: false })),
    ]);
    expect(derived.underPolicy).toBe('cross-model');
    expect(derived.vision).toBe('sometimes');
  });

  it('fails if the default policy flips without the derivation following it', () => {
    /**
     * Both halves, deliberately. ADR 0003 consequence 6 says the default flip is
     * coming, and when it lands the figures above stop describing what callers
     * get by default.
     *
     * Asserting only the equality would let the flip be absorbed by editing
     * `CAPABILITY_POLICY` to match — a one-line change that makes the label
     * accurate and the NUMBERS wrong, which is worse than no label. Asserting
     * only the literal would let the default drift away silently. Together the
     * cheapest green is to change the derivation, which is the point.
     */
    expect(CAPABILITY_POLICY).toBe(DEFAULT_FALLBACK_POLICY);
    expect(CAPABILITY_POLICY).toBe('cross-model');
  });
});

describe('capability availability is measured, not declared', () => {
  it('reports always only when every candidate supports it', () => {
    expect(deriveCapabilities([candidate('a', caps({ vision: true })), candidate('b', caps({ vision: true }))]).vision)
      .toBe('always');
  });

  it('reports sometimes when only some do', () => {
    // The state a boolean has to lie about. `alia-lite` is this case on the live
    // table: four of sixteen candidates support vision while the alias declares
    // `supportsVision: false`.
    expect(deriveCapabilities([candidate('a', caps({ vision: true })), candidate('b', caps({ vision: false }))]).vision)
      .toBe('sometimes');
  });

  it('reports never when none do', () => {
    expect(deriveCapabilities([candidate('a', caps()), candidate('b', caps())]).vision).toBe('never');
  });

  it('reports unknown rather than never when NO candidate record carries the field', () => {
    // The distinction the whole module exists for. `never` says the feature does
    // not work; `unknown` says nobody measured it. A picker greying out a
    // working feature is the bug the first answer produces.
    const withoutVision = { tools: true, maxContextTokens: 1000, maxOutputTokens: 100 };
    const derived = deriveCapabilities([candidate('a', withoutVision), candidate('b', withoutVision)]);
    expect(derived.vision).toBe('unknown');
    // Positive control: `unknown` is not simply what this function returns for
    // everything. A field that IS recorded in the same fixture answers.
    expect(derived.tools).toBe('always');
  });

  it('reports unknown when only SOME candidate records carry the field', () => {
    // Answering from the subset that happens to carry the field is how a partial
    // record becomes a confident wrong claim in whichever direction the subset
    // points.
    const derived = deriveCapabilities([
      candidate('a', { tools: true, vision: true, maxContextTokens: 1, maxOutputTokens: 1 }),
      candidate('b', { tools: true, maxContextTokens: 1, maxOutputTokens: 1 }),
    ]);
    expect(derived.vision).toBe('unknown');
    expect(derived.tools).toBe('always');
  });

  it('reports unknown for reasoning and structured output, because nothing records them', () => {
    // Not an accident of the fixture: no capability record anywhere in this
    // repository has a field for either. `caps()` above is the full recorded
    // vocabulary, and neither name appears in it.
    const derived = deriveCapabilities([candidate('a', caps()), candidate('b', caps())]);
    expect(derived.reasoning).toBe('unknown');
    expect(derived.structuredOutput).toBe('unknown');
    // Positive control in the same currency: three capabilities in the same
    // fixture are NOT unknown, so `unknown` is a finding rather than the
    // function's resting state.
    expect([derived.tools, derived.vision, derived.audio]).toEqual(['always', 'never', 'never']);
  });

  it('bounds tokens by the weakest and the strongest candidate', () => {
    const derived = deriveCapabilities([
      candidate('a', caps({ maxContextTokens: 64000, maxOutputTokens: 4096 })),
      candidate('b', caps({ maxContextTokens: 1000000, maxOutputTokens: 32768 })),
    ]);
    // `guaranteed` is what a caller can rely on whichever candidate answers;
    // publishing only the maximum promises a window most candidates cannot
    // honour.
    expect(derived.contextWindow).toEqual({ guaranteed: 64000, upTo: 1000000 });
    expect(derived.maxOutput).toEqual({ guaranteed: 4096, upTo: 32768 });
  });

  it('reports an unknown token bound as null rather than as a plausible number', () => {
    const derived = deriveCapabilities([
      candidate('a', caps({ maxContextTokens: 64000 })),
      candidate('b', { tools: true, maxOutputTokens: 4096 }),
    ]);
    expect(derived.contextWindow).toBeNull();
    // Positive control: the other bound, fully recorded, still answers. `caps()`
    // supplies 8192 for candidate `a`, so this is also the min/max of two
    // different numbers rather than a degenerate pair.
    expect(derived.maxOutput).toEqual({ guaranteed: 4096, upTo: 8192 });
  });

  it('collapses to a single value for a concrete model, where sometimes cannot occur', () => {
    const derived = deriveCapabilities([candidate('a', caps({ vision: true, maxContextTokens: 200000 }))]);
    expect(derived.vision).toBe('always');
    expect(derived.contextWindow).toEqual({ guaranteed: 200000, upTo: 200000 });
  });
});

describe('entitlement comes from the plan catalogue', () => {
  const plans: PlanGrant[] = [
    { planId: 'free', name: 'Free', product: 'alia', monthlyPrice: 0, isFree: true, modelIds: ['a'] },
    { planId: 'go', name: 'Go', product: 'alia', monthlyPrice: 399, isFree: false, modelIds: ['a', 'b'] },
    { planId: 'pro', name: 'Pro', product: 'alia', monthlyPrice: 999, isFree: false, modelIds: ['a', 'b', 'c'] },
    { planId: 'codea-pro', name: 'Codea Pro', product: 'codea', monthlyPrice: 999, isFree: false, modelIds: ['c'] },
  ];

  it('reports free when a free plan grants it, and names no plan', () => {
    const e = resolveEntitlement('a', plans, null);
    expect(e).toMatchObject({ state: 'known', access: 'free', requiredPlan: null });
  });

  it('names the CHEAPEST paid plan, not the first or the last', () => {
    const e = resolveEntitlement('b', plans, null);
    expect(e).toMatchObject({ state: 'known', access: 'plan', requiredPlan: 'Go' });
    if (e.state !== 'known') throw new Error('unreachable');
    expect(e.grantedBy).toEqual(['go', 'pro']);
  });

  it('records every product whose plans grant it', () => {
    const e = resolveEntitlement('c', plans, null);
    if (e.state !== 'known') throw new Error('unreachable');
    expect([...e.products]).toEqual(['alia', 'codea']);
  });

  it('distinguishes "no plan sells this" from "free"', () => {
    // The conflation `/v1/models` makes, invisible today only because every
    // alias happens to sit on a plan. `requiredPlan: null` alone reads as free.
    const e = resolveEntitlement('nowhere', plans, null);
    expect(e).toMatchObject({ state: 'known', access: 'none', requiredPlan: null });
    if (e.state !== 'known') throw new Error('unreachable');
    expect(e.grantedBy).toEqual([]);
    expect([...e.products]).toEqual([]);
  });

  it('keeps requiredPlan non-null exactly when access is plan', () => {
    for (const id of ['a', 'b', 'c', 'nowhere']) {
      const e = resolveEntitlement(id, plans, null);
      if (e.state !== 'known') throw new Error('unreachable');
      expect(e.requiredPlan !== null).toBe(e.access === 'plan');
    }
  });

  it('breaks a price tie deterministically', () => {
    const tied: PlanGrant[] = [
      { planId: 'zeta', name: 'Zeta', product: 'alia', monthlyPrice: 500, isFree: false, modelIds: ['x'] },
      { planId: 'alpha', name: 'Alpha', product: 'alia', monthlyPrice: 500, isFree: false, modelIds: ['x'] },
    ];
    expect(resolveEntitlement('x', tied, null)).toMatchObject({ requiredPlan: 'Alpha' });
    expect(resolveEntitlement('x', [...tied].reverse(), null)).toMatchObject({ requiredPlan: 'Alpha' });
  });

  it('reports entitled as null for an anonymous caller, never as false', () => {
    // "Nobody's entitlement is being described" and "you may not use this" are
    // different claims, and only the second justifies hiding an entry.
    const anonymous = resolveEntitlement('a', plans, null);
    if (anonymous.state !== 'known') throw new Error('unreachable');
    expect(anonymous.entitled).toBeNull();

    const denied = resolveEntitlement('c', plans, ['a', 'b']);
    if (denied.state !== 'known') throw new Error('unreachable');
    expect(denied.entitled).toBe(false);

    const allowed = resolveEntitlement('c', plans, ['a', 'b', 'c']);
    if (allowed.state !== 'known') throw new Error('unreachable');
    expect(allowed.entitled).toBe(true);
  });
});

describe('the catalogue carries no deprecation signal, because it serves nothing deprecated', () => {
  it('an entry has no deprecation field at all', () => {
    // It used to carry one, and every entry set it, because every entry WAS one
    // of the thirteen deprecated aliases. The catalogue is now keyed by routing
    // profile — the thing an alias BECOMES — so nothing it serves is inside the
    // compatibility window and a permanently-null field would be a declaration
    // nothing enforces.
    //
    // The signal did not disappear, it moved to where the deprecated identifier
    // still is: `middleware/alias-deprecation.ts` sets `Deprecation` and `Link`
    // on any response to a request NAMING an alias, and emits
    // `alia.deprecation` on a stream. A caller still holding one is still told.
    const entry = buildEntry(source({ id: 'profile:lite' }), [candidate('a', caps())], KNOWN, PUBLIC);
    expect(entry).not.toHaveProperty('deprecation');

    // The control: the entry is real and fully built, so "no property" is a
    // fact about the shape and not about an empty object.
    expect(entry.id).toBe('profile:lite');
    expect(entry.capabilities).toBeDefined();
    expect(entry.entitlement).toEqual(KNOWN);
  });
});
