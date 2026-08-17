/**
 * The translation keeps the promise the migration map published — epic #139
 * workstream 18, *"Implement route/model ID translation for compatibility"*.
 *
 * ## Why this file reads the JSON, when `routing-policy.test.ts` deliberately does not
 *
 * That file argues, correctly, that binding the preset table to `ALIA_MODELS`
 * under the map's own stated rule makes the three agree transitively, so reading
 * the JSON there would be a second copy of a coupling already gated.
 *
 * This is a different claim. The map is a document callers were told to migrate
 * by — "a caller can translate mechanically rather than by guesswork",
 * `docs/migration/compatibility-window.md` section (a) — and the property under
 * test is that the code performs THAT translation and not some other one that
 * happens to be internally consistent. A test that recomputed the expected
 * targets from `ROUTING_PRESETS`, the same table the translation is derived
 * from, would measure the derivation against itself and pass however wrong the
 * published answer was. So the expected value comes from the published file, by
 * exact equality, in both directions.
 *
 * ## Vacuity
 *
 * Every way this could pass while measuring nothing is floored: an emptied
 * `aliases` array, a map whose entries parse to `undefined` because a field was
 * renamed, a translation table built from an emptied preset list, and a round
 * trip asserted over zero entries. The count is pinned at thirteen in both the
 * map and the translation, and the parse refuses a malformed file rather than
 * reading `undefined` into every comparison.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { routingProfileSlugSchema, type RoutingTarget } from '@oxyhq/contracts';

import { ALIAS_TRANSLATIONS, translateAlias } from '../alias-translation.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const MAP_PATH = 'docs/migration/alias-migration-map.json';

/** The thirteen the compatibility window is written about. */
const PUBLISHED_ALIAS_COUNT = 13;

interface PublishedAlias {
  readonly alias: string;
  readonly becomes: { readonly kind: string; readonly id: string };
}

/**
 * Parse without `as` on the way in.
 *
 * A cast would let a truncated write or a renamed field read as a map with
 * fewer properties, and every comparison below would then measure `undefined`
 * against `undefined` and pass.
 */
function readPublishedMap(): readonly PublishedAlias[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MAP_PATH), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${MAP_PATH} is not an object`);
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.aliases)) throw new Error(`${MAP_PATH} "aliases" is not an array`);

  return root.aliases.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`alias ${index} is not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.alias !== 'string' || e.alias === '') throw new Error(`alias ${index}: missing alias`);
    const becomes = e.becomes;
    if (typeof becomes !== 'object' || becomes === null) throw new Error(`alias ${index}: missing becomes`);
    const b = becomes as Record<string, unknown>;
    if (typeof b.kind !== 'string' || b.kind === '') throw new Error(`alias ${index}: missing becomes.kind`);
    if (typeof b.id !== 'string' || b.id === '') throw new Error(`alias ${index}: missing becomes.id`);
    return { alias: e.alias, becomes: { kind: b.kind, id: b.id } };
  });
}

const published = readPublishedMap();

describe('every published alias translates', () => {
  it('read a map with all thirteen in it, so nothing below is vacuous', () => {
    // The floor for every assertion in this file. An emptied `aliases` array
    // satisfies "no alias fails to translate" and "no translation disagrees".
    expect(published).toHaveLength(PUBLISHED_ALIAS_COUNT);
    expect(new Set(published.map((entry) => entry.alias)).size).toBe(PUBLISHED_ALIAS_COUNT);
    expect(ALIAS_TRANSLATIONS).toHaveLength(PUBLISHED_ALIAS_COUNT);
  });

  it('covers exactly the aliases the map publishes — no more, no fewer', () => {
    // Both directions. An alias the map names and the code cannot translate is a
    // broken promise; an alias the code translates and the map does not name is
    // a replacement nobody was told about.
    expect(ALIAS_TRANSLATIONS.map((t) => t.alias).sort()).toEqual(
      published.map((entry) => entry.alias).sort(),
    );

    const untranslatable = published
      .filter((entry) => translateAlias(entry.alias).kind !== 'translated')
      .map((entry) => entry.alias);
    expect(untranslatable).toEqual([]);
  });

  it('round-trips to the exact profile id the map publishes, for every alias', () => {
    /**
     * The assertion the checkbox is about. `becomes.id` is `profile:<tier>` and
     * the contract's slug cannot hold a colon, so the wire form drops the
     * prefix and `kind: 'routing_profile'` carries it instead. Re-adding the
     * prefix must reproduce the published string byte for byte — a translation
     * that emitted the tier of a DIFFERENT profile, or that emitted the alias
     * unchanged as `resolveRoutingTarget` used to, fails here.
     */
    const wrong: string[] = [];
    for (const entry of published) {
      const result = translateAlias(entry.alias);
      if (result.kind !== 'translated') {
        wrong.push(`${entry.alias}: answered ${result.kind} instead of translating`);
        continue;
      }
      const { translation } = result;
      if (translation.target.kind !== 'routing_profile') {
        wrong.push(`${entry.alias}: translated to ${translation.target.kind}, map says ${entry.becomes.kind}`);
        continue;
      }
      const roundTripped = `profile:${translation.target.routingProfile}`;
      if (roundTripped !== entry.becomes.id) {
        wrong.push(`${entry.alias}: translates to ${roundTripped}, map publishes ${entry.becomes.id}`);
      }
      if (translation.profileId !== entry.becomes.id) {
        wrong.push(`${entry.alias}: carries profileId ${translation.profileId}, map publishes ${entry.becomes.id}`);
      }
    }
    expect(wrong).toEqual([]);
    // The floor for the loop itself: it ran once per published alias.
    expect(published.length).toBe(PUBLISHED_ALIAS_COUNT);
  });

  it('emits the kind the map classifies, and it is a profile for all thirteen', () => {
    // ADR 0003's discriminator as the map recorded it. An entry reclassified to
    // `concrete-model` without the translation following would ship a profile
    // where a model reference was promised.
    const kinds = new Set(published.map((entry) => entry.becomes.kind));
    expect([...kinds]).toEqual(['routing-profile']);
    expect(ALIAS_TRANSLATIONS.every((t) => t.target.kind === 'routing_profile')).toBe(true);
  });

  it('emits a slug the contract accepts, never the alias and never a model id', () => {
    // The failure this replaces: `alia-v1-pro` travelled as a profile named
    // `alia-v1-pro`. Well-formed, accepted by the schema, and a profile no
    // catalogue outside this repository has heard of.
    for (const translation of ALIAS_TRANSLATIONS) {
      expect(translation.target.kind).toBe('routing_profile');
      if (translation.target.kind !== 'routing_profile') continue;
      const slug = translation.target.routingProfile;
      expect(routingProfileSlugSchema.safeParse(slug).success, `${slug} is not a contract slug`).toBe(true);
      expect(slug).not.toBe(translation.alias);
      expect(slug.startsWith('alia-'), `${slug} is still the alias namespace`).toBe(false);
      expect(slug).not.toContain(':');
      expect(slug).not.toContain('/');
    }
  });

  it('gives two identifiers the same target where the map gives them one profile', () => {
    // `alia-v1-thinking` and `alia-v1-pro-max` are one policy under two names.
    // Read out of the published map rather than named here, so this stops being
    // an assertion about two strings somebody typed.
    const byProfile = new Map<string, string[]>();
    for (const entry of published) {
      byProfile.set(entry.becomes.id, [...(byProfile.get(entry.becomes.id) ?? []), entry.alias]);
    }
    const shared = [...byProfile.entries()].filter(([, aliases]) => aliases.length > 1);
    // The floor: the map still has a shared profile at all. If it stops having
    // one this test measures nothing and must be re-derived, not deleted.
    expect(shared).toHaveLength(1);

    for (const [, aliases] of shared) {
      const targets = aliases.map((alias) => {
        const result = translateAlias(alias);
        return result.kind === 'translated' ? JSON.stringify(result.translation.target) : result.kind;
      });
      expect(new Set(targets).size, `${aliases.join(' and ')} translate differently`).toBe(1);
    }
  });

  it('separates an unregistered ALIAS from an identifier that is not an alias', () => {
    /**
     * The distinction the result type exists for. `alia-flash` is a well-formed
     * profile slug in Alia's own namespace that Alia does not define, and
     * collapsing it into "not mine" is how it once became a silently-substituted
     * default (gate 3's `DANGLING_MODEL_DEFAULTS` records that history). The
     * others are outside the namespace and this module has no opinion on them.
     */
    for (const unregistered of ['alia-flash', 'alia-v2', 'alia-v1-pro-max-plus']) {
      expect(translateAlias(unregistered).kind, `${unregistered} is in Alia's namespace`).toBe(
        'unregistered_alias',
      );
    }
    for (const foreign of ['gpt-4o', 'profile:v1-pro', 'v1-pro', 'alia/v1-pro', 'auto', '']) {
      expect(translateAlias(foreign).kind, `${foreign} is not an alia-* alias`).toBe('not_an_alias');
    }
    // The positive control on the same lookup: it does translate a real one.
    expect(translateAlias('alia-v1-pro').kind).toBe('translated');
  });

  it('the round trip can fail (the control)', () => {
    // Everything above compares a derived string against a published one, and a
    // comparison of a value with itself reports exactly what a correct
    // translation reports. This is the same round trip applied to a target the
    // translation did not produce.
    const impostor: RoutingTarget = { kind: 'routing_profile', routingProfile: 'lite' };
    const proMax = published.find((entry) => entry.alias === 'alia-v1-pro-max');
    expect(proMax?.becomes.id).toBe('profile:v1-pro-max');
    expect(`profile:${impostor.routingProfile}`).not.toBe(proMax?.becomes.id);
  });
});
