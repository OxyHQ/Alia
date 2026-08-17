import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALIA_MODELS } from '../../internal/providers/lib/alia-models.js';
import { ROUTING_PRESETS, getRoutingPreset } from '../routing/presets.js';
import {
  OFFERED_PROFILES,
  PRODUCT_MODES,
  canonicalAliasFor,
  isProfileOffered,
  toRoutableAlias,
  type ProductMode,
} from '../product-modes.js';

/**
 * Product modes — #139 workstream 4, *"replace fake aliases with clearly typed
 * product modes/routing presets"*.
 *
 * Every binding in `product-modes.ts` claims to be READ off something the
 * product already publishes rather than assigned. This file is where that claim
 * is checked, by recomputing each derivation from the live tables and from the
 * consumers on disk. A routing change, a re-priced tier or a Codea default that
 * moved fails here instead of leaving a mode pointing somewhere it no longer
 * belongs.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

function repoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

function mode(id: string): ProductMode {
  const found = PRODUCT_MODES.find((m) => m.id === id);
  if (found === undefined) throw new Error(`no product mode ${id}`);
  return found;
}

/** The profile a mode pins, or `null` when it pins none. */
function pinned(id: string): string | null {
  const routing = mode(id).routing;
  return routing.kind === 'profile' ? routing.profile : null;
}

describe('the mode table is what #139 asks for, and nothing may pass for a model', () => {
  it('names the six modes the epic names, and only those', () => {
    expect(PRODUCT_MODES.map((m) => m.label)).toEqual([
      'Automatic',
      'Fast',
      'Balanced',
      'Maximum quality',
      'Coding',
      'Deep research',
    ]);
  });

  it('identifies each one in the product namespace, never in an alias or publisher namespace', () => {
    // ADR 0002 froze the `alia-*` set, so a mode entering it would be the
    // fourteenth fake alias; `alia/` is the reserved publisher namespace that
    // `lib/reserved-namespace.ts` refuses outright. A mode is neither.
    const ids = PRODUCT_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith('mode:'), id).toBe(true);
      expect(Object.keys(ALIA_MODELS)).not.toContain(id);
      expect(id.includes('/'), id).toBe(false);
    }
  });

  it('pins only profiles that exist in the live preset table', () => {
    const known = new Set(ROUTING_PRESETS.map((preset) => preset.id));
    // Floor: the preset table was loaded. Without it an empty table makes the
    // loop below vacuous and every binding "valid".
    expect(known.size).toBeGreaterThanOrEqual(12);
    for (const m of PRODUCT_MODES) {
      if (m.routing.kind === 'profile') expect(known, m.id).toContain(m.routing.profile);
    }
    // And at least one mode does pin one, or the check above measures nothing.
    expect(PRODUCT_MODES.filter((m) => m.routing.kind === 'profile').length).toBeGreaterThanOrEqual(4);
  });
});

describe('the three general-purpose modes are an ORDERING, not three assignments', () => {
  /**
   * Exactly three identifiers are category `general` and offered in the picker,
   * so ordering them by credit multiplier is total and has no ties: cheapest is
   * Fast, dearest is Maximum quality, the remaining one is Balanced. Recomputed
   * here from `ALIA_MODELS` and the preset table on every run.
   */
  const generalOffered = Object.values(ALIA_MODELS)
    .filter((m) => m.category === 'general' && isProfileOffered(getRoutingPreset(m.id)?.id ?? ''))
    .sort((a, b) => a.creditMultiplier - b.creditMultiplier);

  it('the derivation is total and unambiguous', () => {
    expect(generalOffered).toHaveLength(3);
    // Strictly increasing: a tie would make "cheapest" and "dearest" depend on
    // object key order, and the whole derivation would become an assignment
    // wearing a sort's clothes.
    const multipliers = generalOffered.map((m) => m.creditMultiplier);
    expect(multipliers[0]).toBeLessThan(multipliers[1]);
    expect(multipliers[1]).toBeLessThan(multipliers[2]);
  });

  it('binds Fast, Balanced and Maximum quality to that order', () => {
    const profiles = generalOffered.map((m) => getRoutingPreset(m.id)?.id);
    expect(profiles.every((p) => p !== undefined)).toBe(true);
    expect(pinned('mode:fast')).toBe(profiles[0]);
    expect(pinned('mode:balanced')).toBe(profiles[1]);
    expect(pinned('mode:maximum-quality')).toBe(profiles[2]);
    // The three are distinct, so a table that pointed all of them at one
    // profile could not satisfy the line above by accident.
    expect(new Set(profiles).size).toBe(3);
  });

  it('agrees with the product copy where the product copy says anything', () => {
    // The cross-check, not the derivation. Two of the three descriptions use
    // the mode's own word; the dearest says "Best available models for
    // demanding tasks" rather than "maximum", so it is asserted for what it
    // does say instead of being forced to match a label it never used.
    expect(generalOffered[0].description.toLowerCase()).toContain('fast');
    expect(generalOffered[1].description.toLowerCase()).toContain('balanced');
    expect(generalOffered[2].description.toLowerCase()).toContain('best available');
  });
});

describe('Coding is read off the coding product, not chosen', () => {
  it('pins the profile every Codea surface already defaults to', () => {
    /**
     * Where the Codea default actually lives, and in which vocabulary.
     *
     * Two moves have happened here, each recorded when it happened rather than
     * discovered later. #139 workstream 5 first moved the extension's default
     * out of its three providers into one preference module. It then moved the
     * VOCABULARY: the surfaces now name `profile:v1-codea`, the id
     * `GET /catalogue` publishes and `lib/chat/request-context.ts` accepts,
     * instead of the `alia-v1-codea` alias that #178 stopped advertising.
     *
     * The FACT asserted is unchanged — every Codea surface defaults to one
     * identifier, and it is the coding profile. Only its spelling moved, so the
     * scan moved with it in the same change.
     *
     * `packages/alia-codea/package.json` matters more than it looks: VS Code
     * returns a setting's DECLARED default when the user has not set one, so a
     * manifest still naming the alias would make the extension's own
     * `PREFERRED_MODEL_ID` unreachable. The two agreeing is the thing this
     * checks, not either one alone.
     */
    const defaults = [
      repoFile('packages/alia-codea/package.json'),
      repoFile('packages/alia-codea-cli/src/utils/config.ts'),
      repoFile('packages/alia-codea/src/config.ts'),
    ];
    // Anchored on the `profile:` prefix, which cannot collide the way the alias
    // vocabulary did — `alia-v1` was a PREFIX of `alia-v1-codea`, so a substring
    // scan reported both and the "one identifier" assertion failed on a file
    // naming exactly one.
    const presets = new Set<string>(ROUTING_PRESETS.map((preset) => preset.id));
    const namedIn = (source: string): string[] =>
      [...source.matchAll(/profile:[a-z0-9-]+/g)].map((m) => m[0]).filter((id) => presets.has(id));

    // Positive control: the scan can see an identifier in these files at all. A
    // renamed file would otherwise report "no default found" as agreement.
    for (const source of defaults) expect(namedIn(source).length).toBeGreaterThan(0);

    const named = new Set(defaults.flatMap(namedIn));
    // One identifier across all three, or "the default" is not a single fact.
    expect([...named]).toEqual(['profile:v1-codea']);
    expect(pinned('mode:coding')).toBe('profile:v1-codea');
  });

  it('is a coding-category profile, which the general-purpose three are not', () => {
    expect(ALIA_MODELS['alia-v1-codea'].category).toBe('coding');
    expect(pinned('mode:coding')).not.toBe(pinned('mode:balanced'));
  });
});

describe('two modes pin no profile, because neither changes routing today', () => {
  it('Automatic and Deep research carry the default routing, and nothing else does', () => {
    const unpinned = PRODUCT_MODES.filter((m) => m.routing.kind === 'default').map((m) => m.id);
    expect(unpinned).toEqual(['mode:automatic', 'mode:deep-research']);
  });

  it('Automatic names the path a request with no model already takes', () => {
    // `default` is not a stub: `lib/chat/request-context.ts` falls back to
    // `getDefaultAliaModel()` when the body names no model, which is exactly
    // "the product decides". Asserted against that source so a rewrite that
    // removed the fallback would land here.
    const context = repoFile('packages/api/src/lib/chat/request-context.ts');
    expect(context).toContain('body.model || getDefaultAliaModel()');
    expect(pinned('mode:automatic')).toBeNull();
  });

  it('Deep research differs from Automatic in exactly the request flag it sets', () => {
    // A pipeline, not a tier: the handler runs on whatever the request already
    // resolved, so a profile binding here would be a routing claim the product
    // does not make.
    const handler = repoFile('packages/api/src/lib/chat-modes/deep-research-handler.ts');
    expect(handler).toContain('aliasModelId: string');
    expect(handler).not.toMatch(/'alia-v1[a-z-]*'/);

    expect(PRODUCT_MODES.filter((m) => m.deepResearch).map((m) => m.id)).toEqual(['mode:deep-research']);
    expect(mode('mode:deep-research').routing).toEqual(mode('mode:automatic').routing);

    // And the flag is the one the route reads, not a name invented here.
    expect(repoFile('packages/api/src/lib/chat/request-context.ts')).toContain('body.deepResearch');
  });
});

describe('the product advertises policies, and no `alia-*` identifier anywhere', () => {
  it('offers only profile ids, and every one exists in the preset table', () => {
    const known = new Set(ROUTING_PRESETS.map((preset) => preset.id));
    expect(known.size).toBeGreaterThanOrEqual(12);
    for (const id of OFFERED_PROFILES) expect(known, id).toContain(id);
    expect(new Set(OFFERED_PROFILES).size).toBe(OFFERED_PROFILES.length);
  });

  it('advertises NO alia-* identifier — the property, not the list', () => {
    // #139: the thirteen come off every surface a user or developer sees. This
    // is the invariant behind that, stated so it fails on the shape rather than
    // on a count: an alias re-entering the offered set is red no matter which
    // one it is, and no matter how many.
    const leaked = OFFERED_PROFILES.filter((id) => !id.startsWith('profile:'));
    expect(leaked).toEqual([]);

    const registered = Object.keys(ALIA_MODELS);
    expect(registered.length).toBe(13);
    expect(OFFERED_PROFILES.filter((id) => registered.includes(id))).toEqual([]);
    // Floor: the check above is vacuous over an empty offered set.
    expect(OFFERED_PROFILES.length).toBeGreaterThanOrEqual(4);
  });

  it('offers strictly fewer policies than exist, so the list is a choice', () => {
    expect(OFFERED_PROFILES.length).toBeLessThan(ROUTING_PRESETS.length);
    expect(ROUTING_PRESETS.filter((p) => !isProfileOffered(p.id)).length).toBeGreaterThan(0);
  });

  it('says no to anything that is not an offered policy', () => {
    // The negative control: a predicate answering `true` for everything would
    // satisfy the first case and nothing else. The two alias spellings matter —
    // both are live identifiers that must not be advertised.
    expect(isProfileOffered('alia-v1')).toBe(false);
    expect(isProfileOffered('alia-v1-thinking')).toBe(false);
    expect(isProfileOffered('profile:v1-codea')).toBe(false);
    expect(isProfileOffered('')).toBe(false);
    expect(isProfileOffered('profile:nonsense')).toBe(false);
  });
});

describe('a policy is served by the alias that carries its facts', () => {
  it('derives a canonical alias for every preset, with no table to maintain', () => {
    // Every preset id is `profile:<tier>` and every tier has an `alia-<tier>`,
    // so the canonical identity falls out of the two schemes agreeing. Asserted
    // rather than assumed, because `canonicalAliasOf` throws at module load if
    // it ever stops being true and a throw at import is a bad way to find out.
    for (const preset of ROUTING_PRESETS) {
      const alias = canonicalAliasFor(preset.id);
      expect(alias, preset.id).not.toBeNull();
      expect(preset.aliases, preset.id).toContain(alias);
      expect(ALIA_MODELS[alias ?? ''], preset.id).toBeDefined();
    }
    expect(ROUTING_PRESETS.length).toBeGreaterThanOrEqual(12);
  });

  it('picks the twin the general-purpose ordering picks, on the one contested policy', () => {
    // `profile:v1-pro-max` is the only preset with two aliases. The naming rule
    // and the category rule reach the same answer from independent directions,
    // which is what makes it a derivation rather than a coin toss.
    const contested = ROUTING_PRESETS.filter((preset) => preset.aliases.length > 1);
    expect(contested).toHaveLength(1);
    expect(canonicalAliasFor(contested[0].id)).toBe('alia-v1-pro-max');
    expect(ALIA_MODELS['alia-v1-pro-max'].category).toBe('general');
    expect(ALIA_MODELS['alia-v1-thinking'].category).toBe('coding');
  });

  it('routes a profile to its alias, passes a legacy alias through, refuses a fiction', () => {
    // The three answers kept apart. The middle one is what keeps every
    // installed SDK and CLI copy working while nothing advertises those ids.
    expect(toRoutableAlias('profile:v1')).toBe('alia-v1');
    expect(toRoutableAlias('profile:v1-pro-max')).toBe('alia-v1-pro-max');
    expect(toRoutableAlias('alia-v1-thinking')).toBe('alia-v1-thinking');
    expect(toRoutableAlias('alia-lite')).toBe('alia-lite');
    expect(toRoutableAlias('profile:nonsense')).toBeNull();

    // A non-profile, non-alias identifier is not this function's business — it
    // passes through and the resolver refuses it, which is where the message
    // about unregistered models belongs.
    expect(toRoutableAlias('gpt-4o')).toBe('gpt-4o');
  });

  it('every offered policy is routable end to end', () => {
    // The bijection that matters at runtime: a client can send any id the
    // catalogue advertises and it reaches a registered, priced alias.
    for (const id of OFFERED_PROFILES) {
      const alias = toRoutableAlias(id);
      expect(alias, id).not.toBeNull();
      expect(ALIA_MODELS[alias ?? ''], id).toBeDefined();
      expect(ALIA_MODELS[alias ?? ''].creditMultiplier, id).toBeGreaterThan(0);
    }
  });
});
