/**
 * A provider whose models nobody checks drifts silently: a retired model id
 * typechecks, seeds, and passes every other gate, then 404s at the moment a
 * user's request reaches the upstream.
 *
 * `sync-provider-models` is what checks them, and it can only check a provider
 * it knows how to ask. So the failure this guards is not a wrong URL — it is a
 * provider registered, routed, and quietly absent from both tables, which the
 * script would report as nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { CATALOGUE_PATHS, NO_CATALOGUE, catalogueUrlFor } from '../provider-catalogues.js';
import { PROVIDER_API_HOSTS } from '../../lib/inference/provider-egress-policy.js';
import { GENERATED_TIER_MAPPINGS } from '../../internal/providers/lib/generate-model-mappings.js';

const ROUTED = [
  ...new Set(Object.values(GENERATED_TIER_MAPPINGS).flat().map((m) => m.provider)),
].sort();

describe('every routed provider is either checkable or explicitly excused', () => {
  it('reads a non-trivial routing table', () => {
    // The vacuity floor: an empty table would satisfy every assertion below.
    expect(ROUTED.length).toBeGreaterThan(10);
  });

  it('names every routed provider in exactly one of the two tables', () => {
    const unaccounted = ROUTED.filter(
      (p) => CATALOGUE_PATHS[p] === undefined && NO_CATALOGUE[p] === undefined,
    );
    expect(unaccounted).toEqual([]);

    const both = ROUTED.filter(
      (p) => CATALOGUE_PATHS[p] !== undefined && NO_CATALOGUE[p] !== undefined,
    );
    expect(both).toEqual([]);
  });

  it('can build a URL for every provider it claims to check', () => {
    // The host comes from the egress map, so a provider with a path and no host
    // would silently become uncheckable at runtime rather than here.
    const unbuildable = Object.keys(CATALOGUE_PATHS).filter((p) => catalogueUrlFor(p) === null);
    expect(unbuildable).toEqual([]);
  });

  it('dials only hosts the egress policy already allows', () => {
    // Not a second opinion about where a provider lives: the URL is BUILT from
    // that map, and this asserts the property that makes it safe to do so.
    const allowed = new Set(Object.values(PROVIDER_API_HOSTS));
    for (const provider of Object.keys(CATALOGUE_PATHS)) {
      const url = catalogueUrlFor(provider);
      expect(url).not.toBeNull();
      expect(allowed.has(new URL(url as string).host)).toBe(true);
    }
  });

  it('and the accounting can still fail', () => {
    // Without this, tables that happened to cover everything would pass the
    // assertions above whether or not they measure anything.
    expect(CATALOGUE_PATHS['definitely-not-a-provider']).toBeUndefined();
    expect(NO_CATALOGUE['definitely-not-a-provider']).toBeUndefined();
    expect(catalogueUrlFor('definitely-not-a-provider')).toBeNull();
  });
});
