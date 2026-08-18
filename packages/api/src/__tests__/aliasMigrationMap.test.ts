/**
 * The alias migration map must keep describing the routing it claims to describe.
 *
 * `docs/migration/alias-migration-map.json` is the map the compatibility window
 * requires before any alias can be removed (section (a), removal gate 2). A map
 * like that rots in one direction: the routing table moves, the map does not,
 * and it goes on reading as authoritative while stating a fan-out that stopped
 * being true three PRs ago.
 *
 * ## What each assertion is for
 *
 * **Exactly the thirteen.** No more, no fewer, asserted against the RUNTIME
 * catalogue rather than a copy of the list — a fourteenth alias must break this
 * file, and a map entry for an alias that no longer exists must break it too.
 *
 * **Every count recomputed.** `distinctModels` and `distinctProviders` are read
 * back off `TIER_MODEL_MAPPINGS` through the same client product code uses. This
 * is what makes the file a measurement rather than a snapshot of somebody's
 * afternoon: change the routing and this goes red.
 *
 * **The classification follows from the counts.** "Routing profile" is not an
 * opinion recorded in a string; it is `distinctModels >= 2`, checked. An entry
 * claiming `concrete-model` while fanning out to nine models fails.
 *
 * ## Vacuity
 *
 * A JSON file that fails to parse, a `getTierMappings()` that answers `{}`, and
 * a map with an empty `aliases` array all satisfy "no entry disagrees with the
 * routing". So the catalogue is floored, the mapping lookup is asserted
 * non-empty for every alias, and the parse refuses a malformed file rather than
 * reading `undefined` into every comparison.
 *
 * ## Why this reads the runtime through `gateway-client`
 *
 * Not for convenience: `architectureGates.test.ts` freezes every module
 * reference that crosses into `src/internal/providers/` as an exact list, and a
 * direct import of `alia-models` here would be a new pair on it. `gateway-client`
 * is the sanctioned seam (ADR 0001), it is what `chat-core` calls, and with no
 * gateway configured it answers from the same in-process tables.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getAllAliaModels, getTierMappings } from '../lib/gateway-client.js';
import { ALIAS_DEPRECATION, ALIAS_SUNSET, DEPRECATED_ALIASES } from '../middleware/alias-deprecation.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const MAP_PATH = 'docs/migration/alias-migration-map.json';

const KINDS = new Set(['routing-profile', 'concrete-model']);

interface AliasEntry {
  readonly alias: string;
  readonly becomes: { readonly kind: string; readonly id: string };
  readonly tier: string;
  readonly distinctModels: number;
  readonly distinctProviders: number;
  readonly evidence: string;
}

interface AliasMap {
  readonly deprecatedAt: string;
  readonly sunsetAt: string | null;
  readonly aliases: readonly AliasEntry[];
}

/**
 * Parse without `as` on the way in.
 *
 * A cast would let a truncated write or a renamed field read as a map with
 * fewer properties, and every comparison below would then quietly measure
 * `undefined` against `undefined` and pass.
 */
function readMap(): AliasMap {
  const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MAP_PATH), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${MAP_PATH} is not an object`);
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.aliases)) throw new Error(`${MAP_PATH} "aliases" is not an array`);
  if (typeof root.deprecatedAt !== 'string') throw new Error(`${MAP_PATH} "deprecatedAt" is not a string`);
  if (root.sunsetAt !== null && typeof root.sunsetAt !== 'string') {
    throw new Error(`${MAP_PATH} "sunsetAt" is neither null nor a string`);
  }

  const aliases = root.aliases.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`alias ${index} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const field of ['alias', 'tier', 'evidence']) {
      if (typeof e[field] !== 'string' || e[field] === '') throw new Error(`alias ${index}: missing ${field}`);
    }
    for (const field of ['distinctModels', 'distinctProviders']) {
      if (typeof e[field] !== 'number') throw new Error(`alias ${index}: ${field} is not a number`);
    }
    const becomes = e.becomes;
    if (typeof becomes !== 'object' || becomes === null) throw new Error(`alias ${index}: missing becomes`);
    const b = becomes as Record<string, unknown>;
    if (typeof b.kind !== 'string' || typeof b.id !== 'string') throw new Error(`alias ${index}: malformed becomes`);
    return entry as AliasEntry;
  });

  return { deprecatedAt: root.deprecatedAt, sunsetAt: root.sunsetAt as string | null, aliases };
}

const map = readMap();

describe('the alias migration map covers exactly the frozen alias set', () => {
  it('parsed a non-empty map, so the assertions below are not vacuous', () => {
    // An empty `aliases` array satisfies every "no entry disagrees" check below.
    expect(map.aliases.length).toBeGreaterThan(0);
    expect(new Set(map.aliases.map((a) => a.alias)).size).toBe(map.aliases.length);
  });

  it('covers exactly the aliases the runtime serves — no more, no fewer', async () => {
    const served = (await getAllAliaModels()).map((m) => m.id);

    // The vacuity floor for the comparison: a catalogue that answered nothing
    // would make an empty map look complete.
    expect(served.length).toBe(13);

    expect(map.aliases.map((a) => a.alias).sort()).toEqual([...served].sort());
    // And the middleware's own copy of the set, so the deprecation signal cannot
    // drift away from the map that tells callers what to do about it.
    expect([...DEPRECATED_ALIASES].sort()).toEqual([...served].sort());
  });

  it('records each alias against the tier the catalogue actually gives it', async () => {
    const tierOf = new Map((await getAllAliaModels()).map((m) => [m.id, m.tier]));
    const wrong = map.aliases
      .filter((a) => tierOf.get(a.alias) !== a.tier)
      .map((a) => `${a.alias}: map says ${a.tier}, catalogue says ${String(tierOf.get(a.alias))}`);
    expect(wrong).toEqual([]);
  });

  it('recomputes every fan-out count from the live routing table', async () => {
    const mappings = await getTierMappings();

    // Positive control on the instrument, chosen rather than found: `lite` is
    // the tier ADR 0003 cites by line as the clearest routing policy in the
    // codebase, and it is the last thing a routing change would empty. If this
    // ever legitimately reaches zero the whole file is measuring nothing and
    // must be re-derived, not adjusted.
    expect((mappings.lite ?? []).length).toBeGreaterThanOrEqual(2);

    const drift: string[] = [];
    for (const entry of map.aliases) {
      const forTier = mappings[entry.tier] ?? [];
      // Each alias's own floor: a tier that vanished would otherwise make its
      // counts "agree" at zero if the map were ever edited down to match.
      if (forTier.length === 0) {
        drift.push(`${entry.alias}: tier ${entry.tier} has no mappings at all`);
        continue;
      }
      const models = new Set(forTier.map((m) => m.modelId)).size;
      const providers = new Set(forTier.map((m) => m.provider)).size;
      if (models !== entry.distinctModels) {
        drift.push(`${entry.alias}: map says ${entry.distinctModels} models, table has ${models}`);
      }
      if (providers !== entry.distinctProviders) {
        drift.push(`${entry.alias}: map says ${entry.distinctProviders} providers, table has ${providers}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('classifies by fan-out rather than by assertion', () => {
    // ADR 0003's discriminator, applied: one model means a reference to that
    // model, several means a policy over several. An entry claiming
    // `concrete-model` while fanning out, or `routing-profile` while resolving
    // to exactly one, is the mislabelling this catches.
    const wrong = map.aliases
      .filter((a) => {
        if (!KINDS.has(a.becomes.kind)) return true;
        return a.becomes.kind === 'routing-profile' ? a.distinctModels < 2 : a.distinctModels !== 1;
      })
      .map((a) => `${a.alias}: ${a.becomes.kind} with ${a.distinctModels} models`);
    expect(wrong).toEqual([]);
  });

  it('never writes a routing profile in <publisher>/<model> form', () => {
    // ADR 0003's routing-profile identity rule. A profile that parses as a model
    // identity is exactly the confusion the whole ADR exists to end, and it is
    // one careless rename away at any time.
    const shaped = map.aliases
      .filter((a) => a.becomes.kind === 'routing-profile' && a.becomes.id.includes('/'))
      .map((a) => `${a.alias} -> ${a.becomes.id}`);
    expect(shaped).toEqual([]);

    // Vacuity floor: the check above is empty-true if no entry is a profile.
    expect(map.aliases.filter((a) => a.becomes.kind === 'routing-profile').length).toBeGreaterThanOrEqual(13);
  });

  it('agrees with the deprecation signal on BOTH dates, including the sunset', () => {
    expect(new Date(map.deprecatedAt).getTime()).toBe(ALIAS_DEPRECATION.getTime());

    // Both halves of the removal date, so that setting one without the other is
    // red: a map date the header does not emit is a promise nobody is keeping,
    // and a header date the map does not carry is a date with no published gate
    // behind it. The product owner set this one on 2026-08-18 (D1).
    expect(map.sunsetAt).toBe('2026-10-01T00:00:00.000Z');
    expect(map.sunsetAt).toBe(ALIAS_SUNSET.toISOString());

    // Vacuity floor. `toBe` between two reads of the same absent value is what
    // the previous shape of this test asserted, and `null === null` passes
    // whether or not either side is wired to anything.
    expect(map.sunsetAt).not.toBeNull();
  });
});
