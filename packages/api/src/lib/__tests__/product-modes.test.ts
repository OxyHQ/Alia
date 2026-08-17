import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALIA_MODELS } from '../../internal/providers/lib/alia-models.js';
import { ROUTING_PRESETS, getRoutingPreset } from '../routing/presets.js';
import { PRODUCT_MODES, VISIBLE_PROFILES, isAliasVisible, type ProductMode } from '../product-modes.js';

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
   * here from `ALIA_MODELS` and `VISIBLE_PROFILES` on every run.
   */
  const generalOffered = Object.values(ALIA_MODELS)
    .filter((m) => m.category === 'general' && isAliasVisible(m.id))
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
    const defaults = [
      repoFile('packages/alia-codea/package.json'),
      repoFile('packages/alia-codea-cli/src/utils/config.ts'),
      repoFile('packages/alia-codea/src/inlineCompletionProvider.ts'),
    ];
    // Greedy whole-token matching, never `includes`: `alia-v1` is a PREFIX of
    // `alia-v1-codea`, so a substring scan reports both and the "one
    // identifier" assertion below would fail on a file that names exactly one.
    const registered = new Set(Object.keys(ALIA_MODELS));
    const namedIn = (source: string): string[] =>
      [...source.matchAll(/alia-[a-z0-9-]+/g)].map((m) => m[0]).filter((id) => registered.has(id));

    // Positive control: the scan can see an alias in these files at all. A
    // renamed file would otherwise report "no default found" as agreement.
    for (const source of defaults) expect(namedIn(source).length).toBeGreaterThan(0);

    const named = new Set(defaults.flatMap(namedIn));
    // One identifier across all three, or "the default" is not a single fact.
    expect([...named]).toEqual(['alia-v1-codea']);
    expect(pinned('mode:coding')).toBe(getRoutingPreset('alia-v1-codea')?.id);
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

describe('visibility is product configuration, and it changed nothing a client sees', () => {
  /**
   * The five identifiers that carried `chatVisible: true` inside
   * `internal/providers/lib/alia-models.ts` before this moved out of the
   * provider mapping table. Written out because the field they came from no
   * longer exists: this is the record of what the product offered, and the
   * assertion that moving the decision did not quietly change it.
   */
  const OFFERED_BEFORE = ['alia-lite', 'alia-v1', 'alia-v1-pro', 'alia-v1-thinking', 'alia-v1-pro-max'];

  it('offers exactly the identifiers the provider table used to offer', () => {
    const offered = Object.keys(ALIA_MODELS).filter(isAliasVisible).sort();
    expect(offered).toEqual([...OFFERED_BEFORE].sort());
  });

  it('offers strictly fewer than everything, so the filter is a filter', () => {
    const all = Object.keys(ALIA_MODELS);
    expect(all.length).toBeGreaterThan(OFFERED_BEFORE.length);
    expect(all.filter((id) => !isAliasVisible(id)).length).toBeGreaterThan(0);
  });

  it('is keyed by profile, so two names for one policy cannot disagree', () => {
    // `alia-v1-thinking` and `alia-v1-pro-max` are one profile under two
    // identifiers. Alias-keyed visibility could offer one and hide the other,
    // which renders as two entries that route identically or one that is
    // hidden for no reason.
    expect(getRoutingPreset('alia-v1-thinking')?.id).toBe(getRoutingPreset('alia-v1-pro-max')?.id);
    expect(isAliasVisible('alia-v1-thinking')).toBe(isAliasVisible('alia-v1-pro-max'));
  });

  it('says no to an identifier no preset claims', () => {
    // The negative control: a predicate that answered `true` for everything
    // would satisfy the first case here and nothing else.
    expect(isAliasVisible('alia-flash')).toBe(false);
    expect(isAliasVisible('gpt-4o')).toBe(false);
    expect(isAliasVisible('')).toBe(false);
    expect(VISIBLE_PROFILES.length).toBeLessThan(ROUTING_PRESETS.length);
  });
});
