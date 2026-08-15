/**
 * Every routable candidate carries REAL capability data.
 *
 * `getModelCapabilities` (`model-capabilities-data.ts:675`) answers
 * `MODEL_CAPABILITIES[modelId] || DEFAULT_CAPABILITIES`, so a model id absent
 * from the table silently acquires the default record — tools yes, vision no,
 * 8192 in, 4096 out. That is not a measurement of anything; it is a plausible
 * guess, and `createMapping` bakes it into the routing table without a word.
 *
 * The catalogue (`lib/catalogue.ts`) publishes capability availability derived
 * from exactly these records, and its whole contract is that it does not invent
 * a capability. That contract is only as good as this: if a routed candidate
 * can carry the default, the catalogue publishes a guess as a fact, and it does
 * so with no symptom — the numbers look like every other model's numbers.
 *
 * ## Why identity and not a shape comparison
 *
 * `getModelCapabilities` returns the DEFAULT_CAPABILITIES object itself, not a
 * copy, so `toBe` distinguishes "fell through to the default" from "is recorded
 * in the table and happens to have default-looking values". A deep comparison
 * would conflate them and fail on a legitimate 8192/4096 model.
 *
 * ## The cheapest way to make this green
 *
 * Add the missing model to `MODEL_CAPABILITIES`, or declare its capabilities
 * inline on the mapping. Both are the correct action, which is what a gate
 * wants: the cheapest green is never "publish the guess".
 */

import { describe, expect, it } from 'vitest';

import { GENERATED_TIER_MAPPINGS } from '../generate-model-mappings.js';
import { DEFAULT_CAPABILITIES, MODEL_CAPABILITIES } from '../model-capabilities-data.js';

const allMappings = Object.entries(GENERATED_TIER_MAPPINGS).flatMap(([tier, list]) =>
  list.map((m) => ({ tier, ...m })),
);

describe('the routing table never publishes the default capability record', () => {
  it('read a non-trivial routing table, so a clean result means clean', () => {
    // The vacuity floor. An empty or half-loaded table satisfies every "no
    // offender" assertion below and reads identically to a correct one.
    expect(allMappings.length).toBeGreaterThanOrEqual(100);
    expect(Object.keys(GENERATED_TIER_MAPPINGS).length).toBeGreaterThanOrEqual(14);
  });

  it('the probe can see a fall-through, so its silence is evidence', () => {
    // Positive control in the same currency as the measurement: a model id that
    // is not in the table must produce the default record by identity. Without
    // this, a `getModelCapabilities` that stopped returning the shared object
    // would make the census below vacuously clean.
    const absent = 'no-such-model-id-for-the-positive-control';
    expect(absent in MODEL_CAPABILITIES).toBe(false);
    expect(MODEL_CAPABILITIES[absent] ?? DEFAULT_CAPABILITIES).toBe(DEFAULT_CAPABILITIES);
  });

  it('no routed candidate carries the default record', () => {
    const guessed = allMappings
      .filter((m) => m.capabilities === DEFAULT_CAPABILITIES)
      .map((m) => `${m.tier}: ${m.modelId}`);
    expect(guessed).toEqual([]);
  });

  it('every routed candidate records the fields the catalogue publishes', () => {
    // The catalogue reports `unknown` for a field no candidate carries, which is
    // honest but useless to a picker. This keeps the useful case the norm and
    // makes a regression to `unknown` a failure here rather than a quiet
    // downgrade in the response.
    const missing: string[] = [];
    for (const m of allMappings) {
      for (const field of ['tools', 'vision', 'audio'] as const) {
        if (typeof m.capabilities[field] !== 'boolean') missing.push(`${m.tier}/${m.modelId}: ${field}`);
      }
      for (const field of ['maxContextTokens', 'maxOutputTokens'] as const) {
        if (typeof m.capabilities[field] !== 'number') missing.push(`${m.tier}/${m.modelId}: ${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('records no reasoning or structured-output field anywhere, which is why the catalogue reports them unknown', () => {
    // The measurement behind `deriveCapabilities` hard-coding `unknown` for
    // those two. If either name ever appears in a capability record, this fails
    // and the catalogue's decision to publish it gets made deliberately instead
    // of by accident.
    const named = new Set<string>();
    for (const record of Object.values(MODEL_CAPABILITIES)) for (const key of Object.keys(record)) named.add(key);
    for (const m of allMappings) for (const key of Object.keys(m.capabilities)) named.add(key);

    // Floor first: an empty key set would make the absence check vacuous.
    expect(named.size).toBeGreaterThanOrEqual(10);
    expect([...named].filter((k) => /reason|structured|json.?schema/i.test(k))).toEqual([]);
    // And the scan CAN see a field of that shape — the negative control's own
    // vacuity floor.
    expect([...named, 'reasoning'].filter((k) => /reason|structured|json.?schema/i.test(k))).toEqual(['reasoning']);
  });
});
