/**
 * The seed drops a mapping whose provider it does not recognise, and reports
 * that as an info log and a `skipped` count — never as an error. So a routing
 * table naming a provider the seed turns away is invisible at runtime: the
 * catalogue is simply missing rows nobody asked for.
 *
 * That is exactly what happened. `seed-model-configs.ts` carried a hand-written
 * copy of the provider list, `digitalocean` was added everywhere else and never
 * to that copy, and its three mappings were dropped on every seed. The list is
 * now derived from `PROVIDER_NAMES`; this is the gate that keeps it derived.
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_NAMES } from '../provider-names.js';
import { GENERATED_TIER_MAPPINGS } from '../generate-model-mappings.js';

const MAPPINGS = Object.values(GENERATED_TIER_MAPPINGS).flat();
const ROUTED_PROVIDERS = [...new Set(MAPPINGS.map((m) => m.provider))].sort();
const ADMITTED = new Set<string>(PROVIDER_NAMES);

describe('every routed provider survives the seed', () => {
  it('reads a non-trivial routing table', () => {
    // The vacuity floor. An emptied or renamed table would let every assertion
    // below pass over nothing and report what a working gate reports.
    expect(MAPPINGS.length).toBeGreaterThan(100);
    expect(ROUTED_PROVIDERS.length).toBeGreaterThan(10);
  });

  it('admits every provider the routing table actually names', () => {
    // The defect this replays: `digitalocean` routed here and was refused by
    // the seed's own copy of the list, silently.
    expect(ROUTED_PROVIDERS.filter((provider) => !ADMITTED.has(provider))).toEqual([]);
  });

  it('and the predicate can still refuse something', () => {
    // Without this, an `ADMITTED` set that somehow contained everything would
    // pass the assertion above while measuring nothing.
    expect(ADMITTED.has('definitely-not-a-registered-provider')).toBe(false);
  });
});
