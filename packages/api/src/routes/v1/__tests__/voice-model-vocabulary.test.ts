import { describe, expect, it } from 'vitest';
import { aliasesForProfile, translateAlias } from '../../../lib/routing/alias-translation.js';

/**
 * The two vocabularies meet at the voice gate, and before this they missed.
 *
 * `@alia.onl/sdk` sends `profile:v1-voice` (`lib/config.ts`'s
 * `PREFERRED_VOICE_MODEL_ID`). `allowedModelIds` comes from `plans.model_ids`,
 * keyed by the `alia-*` aliases. `routes/v1/voice.ts` compared one against the
 * other, so voice mode answered `MODEL_NOT_IN_PLAN` — "upgrade your plan" — to
 * every account on every plan, including one holding the most expensive plan
 * there is. A permission error no permission could satisfy.
 *
 * These cases are about the BRIDGE, in both directions, because a one-way
 * mapping is what the code had.
 */
describe('a routing profile resolves to the aliases entitlements are keyed by', () => {
  it('translates the profile the SDK actually sends', () => {
    // The literal value of `PREFERRED_VOICE_MODEL_ID`. If the SDK's default
    // changes, this is the case that says so.
    expect(aliasesForProfile('profile:v1-voice')).toContain('alia-v1-voice');
  });

  it('round-trips: every alias translates to a profile that names it back', () => {
    // The vacuity floor and the symmetry in one: a bridge that answered nothing
    // would pass an "is it in the list" assertion over an empty list.
    const aliases = ['alia-lite', 'alia-v1', 'alia-v1-voice', 'alia-v1-voice-pro', 'alia-v1-pro'];
    for (const alias of aliases) {
      const result = translateAlias(alias);
      expect(result.kind, `${alias} does not translate`).toBe('translated');
      if (result.kind !== 'translated') continue;
      expect(
        aliasesForProfile(result.translation.profileId),
        `${result.translation.profileId} forgets ${alias}`,
      ).toContain(alias);
    }
  });

  it('carries every alias of a profile that has two', () => {
    // `profile:v1-pro-max` stands for two live identifiers, and a caller
    // holding either must pass the gate. Taking only the first would refuse the
    // other half of a plan's grant.
    const result = translateAlias('alia-v1-thinking');
    expect(result.kind).toBe('translated');
    if (result.kind !== 'translated') return;
    expect([...aliasesForProfile(result.translation.profileId)].sort()).toEqual([
      'alia-v1-pro-max',
      'alia-v1-thinking',
    ]);
  });

  it('answers empty for something that is not a profile, rather than guessing', () => {
    // A concrete model reference is nobody's alias, and inventing one here
    // would put a made-up identifier into an entitlement check.
    expect(aliasesForProfile('openai/gpt-4o')).toEqual([]);
    expect(aliasesForProfile('alia-v1-voice')).toEqual([]);
    expect(aliasesForProfile('profile:does-not-exist')).toEqual([]);
  });
});
