import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { KAANA_ROUTING_PROFILES } from '../../internal/providers/lib/routing-profile-catalogue.js';
import { ROUTING_PRESETS } from '../routing/presets.js';
import {
  OFFERED_PROFILES,
  PRODUCT_MODES,
  routingProfileFor,
  isProfileOffered,
  toRoutingProfile,
  type ProductMode,
} from '../product-modes.js';

/**
 * Product modes — #139 workstream 4, *"replace fake aliases with clearly typed
 * product modes/routing presets"*.
 *
 * Every binding in `product-modes.ts` is an explicit product decision. This
 * file checks those exact identities against the live tables. A routing change
 * cannot silently retarget a mode through array order, price sorting or an
 * implicit default.
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

/** The exact profile a mode pins. */
function pinned(id: string): string {
  return mode(id).routing.profile;
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
    // fourteenth product model; `alia/` is the reserved publisher namespace that
    // `lib/reserved-namespace.ts` refuses outright. A mode is neither.
    const ids = PRODUCT_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith('mode:'), id).toBe(true);
      expect(Object.keys(KAANA_ROUTING_PROFILES)).not.toContain(id);
      expect(id.includes('/'), id).toBe(false);
    }
  });

  it('pins only profiles that exist in the live preset table', () => {
    const known = new Set(ROUTING_PRESETS.flatMap((preset) => preset.profileIds));
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

describe('general-purpose modes pin exact profile identities', () => {
  it('does not derive routing from price, order or a first row', () => {
    expect(pinned('mode:automatic')).toBe('kaana-lite');
    expect(pinned('mode:fast')).toBe('kaana-lite');
    expect(pinned('mode:balanced')).toBe('kaana-v1');
    expect(pinned('mode:maximum-quality')).toBe('kaana-v1-pro-max');
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
     * VOCABULARY: the surfaces now name `kaana-v1-codea`, the id
     * `GET /catalogue` publishes and `lib/chat/request-context.ts` accepts,
     * instead of the `kaana-v1-codea` routing profile that #178 stopped advertising.
     *
     * The FACT asserted is unchanged — every Codea surface defaults to one
     * identifier, and it is the coding profile. Only its spelling moved, so the
     * scan moved with it in the same change.
     *
     * `packages/alia-codea/package.json` matters more than it looks: VS Code
     * returns a setting's DECLARED default when the user has not set one, so a
     * manifest still naming the removed identifier would make the extension's own
     * `PREFERRED_MODEL_ID` unreachable. The two agreeing is the thing this
     * checks, not either one alone.
     */
    const defaults = [
      repoFile('packages/alia-codea/package.json'),
      repoFile('packages/alia-codea-cli/src/utils/config.ts'),
      repoFile('packages/alia-codea/src/config.ts'),
    ];
    const presets = new Set<string>(ROUTING_PRESETS.flatMap((preset) => preset.profileIds));
    const namedIn = (source: string): string[] =>
      [...source.matchAll(/kaana-[a-z0-9-]+/g)].map((m) => m[0]).filter((id) => presets.has(id));

    // Positive control: the scan can see an identifier in these files at all. A
    // renamed file would otherwise report "no default found" as agreement.
    for (const source of defaults) expect(namedIn(source).length).toBeGreaterThan(0);

    const named = new Set(defaults.flatMap(namedIn));
    // One identifier across all three, or "the default" is not a single fact.
    expect([...named]).toEqual(['kaana-v1-codea']);
    expect(pinned('mode:coding')).toBe('kaana-v1-codea');
  });

  it('is a coding-category profile, which the general-purpose three are not', () => {
    expect(KAANA_ROUTING_PROFILES['kaana-v1-codea'].category).toBe('coding');
    expect(pinned('mode:coding')).not.toBe(pinned('mode:balanced'));
  });
});

describe('Automatic and Deep research have no implicit routing default', () => {
  it('pins both to the exact current product identity', () => {
    expect(pinned('mode:automatic')).toBe('kaana-lite');
    expect(pinned('mode:deep-research')).toBe('kaana-lite');
  });

  it('Deep research differs from Automatic in exactly the request flag it sets', () => {
    const handler = repoFile('packages/api/src/lib/chat-modes/deep-research-handler.ts');
    expect(handler).toContain('routingProfileId: string');
    expect(handler).not.toMatch(/'kaana-v1[a-z-]*'/);

    expect(PRODUCT_MODES.filter((m) => m.deepResearch).map((m) => m.id)).toEqual(['mode:deep-research']);
    expect(mode('mode:deep-research').routing).toEqual(mode('mode:automatic').routing);

    // And the flag is the one the route reads, not a name invented here.
    expect(repoFile('packages/api/src/lib/chat/request-context.ts')).toContain('body.deepResearch');
  });
});

describe('the product advertises policies, and no `alia-*` identifier anywhere', () => {
  it('offers only profile ids, and every one exists in the preset table', () => {
    const known = new Set(ROUTING_PRESETS.flatMap((preset) => preset.profileIds));
    expect(known.size).toBeGreaterThanOrEqual(12);
    for (const id of OFFERED_PROFILES) expect(known, id).toContain(id);
    expect(new Set(OFFERED_PROFILES).size).toBe(OFFERED_PROFILES.length);
  });

  it('advertises NO alia-* identifier — the property, not the list', () => {
    // #139: the thirteen come off every surface a user or developer sees. This
    // is the invariant behind that, stated so it fails on the shape rather than
    // on a count: a retired identifier re-entering the offered set is red no matter which
    // one it is, and no matter how many.
    const leaked = OFFERED_PROFILES.filter((id) => !id.startsWith('kaana-'));
    expect(leaked).toEqual([]);

    const registered = Object.keys(KAANA_ROUTING_PROFILES);
    expect(registered.length).toBe(13);
    expect(OFFERED_PROFILES.filter((id) => registered.includes(id))).toEqual(OFFERED_PROFILES);
    // Floor: the check above is vacuous over an empty offered set.
    expect(OFFERED_PROFILES.length).toBeGreaterThanOrEqual(4);
  });

  it('offers strictly fewer policies than exist, so the list is a choice', () => {
    expect(OFFERED_PROFILES.length).toBeLessThan(ROUTING_PRESETS.length);
    expect(ROUTING_PRESETS.flatMap((p) => p.profileIds).filter((id) => !isProfileOffered(id)).length).toBeGreaterThan(0);
  });

  it('says no to anything that is not an offered policy', () => {
    // The negative control: a predicate answering `true` for everything would
    // satisfy the first case and nothing else. The internal policy spelling is
    // not a public routing profile and must not be advertised.
    expect(isProfileOffered('kaana-v1')).toBe(true);
    expect(isProfileOffered('kaana-v1-thinking')).toBe(false);
    expect(isProfileOffered('profile:v1-codea')).toBe(false);
    expect(isProfileOffered('')).toBe(false);
    expect(isProfileOffered('profile:nonsense')).toBe(false);
  });
});

describe('a policy is served by its canonical Kaana routing profile', () => {
  it('defines a primary canonical routing profile for every preset', () => {
    for (const preset of ROUTING_PRESETS) {
      const profileId = routingProfileFor(preset.id);
      expect(profileId, preset.id).not.toBeNull();
      expect(preset.profileIds, preset.id).toContain(profileId);
      expect(KAANA_ROUTING_PROFILES[profileId ?? ''], preset.id).toBeDefined();
    }
    expect(ROUTING_PRESETS.length).toBeGreaterThanOrEqual(12);
  });

  it('picks the twin the general-purpose ordering picks, on the one contested policy', () => {
    // `profile:v1-pro-max` is the only preset with two routing profiles. The naming rule
    // and the category rule reach the same answer from independent directions,
    // which is what makes it a derivation rather than a coin toss.
    const contested = ROUTING_PRESETS.filter((preset) => preset.profileIds.length > 1);
    expect(contested).toHaveLength(1);
    expect(routingProfileFor(contested[0].id)).toBe('kaana-v1-pro-max');
    expect(KAANA_ROUTING_PROFILES['kaana-v1-pro-max'].category).toBe('general');
    expect(KAANA_ROUTING_PROFILES['kaana-v1-thinking'].category).toBe('coding');
  });

  it('accepts canonical Kaana profiles and translates no compatibility spelling', () => {
    expect(toRoutingProfile('kaana-v1-thinking')).toBe('kaana-v1-thinking');
    expect(toRoutingProfile('kaana-lite')).toBe('kaana-lite');
    expect(toRoutingProfile('profile:v1')).toBeNull();
    expect(toRoutingProfile('alia-v1')).toBeNull();
    expect(toRoutingProfile('gpt-4o')).toBeNull();
  });

  it('every offered policy is routable end to end', () => {
    // The bijection that matters at runtime: a client can send any id the
    // catalogue advertises and it reaches a registered, priced routing profile.
    for (const id of OFFERED_PROFILES) {
      const profileId = toRoutingProfile(id);
      expect(profileId, id).not.toBeNull();
      expect(KAANA_ROUTING_PROFILES[profileId ?? ''], id).toBeDefined();
      expect(KAANA_ROUTING_PROFILES[profileId ?? ''].creditMultiplier, id).toBeGreaterThan(0);
    }
  });
});
