import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ROUTING_PRESETS } from '../../routing/presets.js';
import { KAANA_ROUTING_PROFILE_IDS } from '../../routing/kaana-profiles.js';
import { classifyRequestedModel, reasoningEffortOf } from '../requested-model.js';
import { EFFORT_LEVELS } from '../../reasoning-effort.js';

/**
 * What the caller asked for, and what it IS — epic #139 workstream 5, *"Record
 * the requested model/profile ... in product analytics"*, read with the decision
 * that `kaana-*` is the one routing-profile vocabulary.
 *
 * The property under test is not "the classifier returns strings". It is that
 * routing profiles and concrete model references stay APART. Each case below
 * pairs a shape with a discriminator that fails if the classifier collapses it
 * into another.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));

describe('classifyRequestedModel', () => {
  it('reads all thirteen Kaana ids as canonical routing profiles', () => {
    expect(KAANA_ROUTING_PROFILE_IDS).toHaveLength(13);
    for (const profileId of KAANA_ROUTING_PROFILE_IDS) {
      expect(classifyRequestedModel(profileId), profileId).toEqual({
        id: profileId,
        kind: 'routing_profile',
        profileId,
      });
    }
  });

  it('does not treat the removed profile:* layer as a routing profile', () => {
    for (const preset of ROUTING_PRESETS) {
      expect(classifyRequestedModel(preset.id), preset.id).toEqual({
        id: preset.id,
        kind: 'unregistered',
        profileId: null,
      });
    }
  });

  it('reads a concrete model reference as a model, with no profile', () => {
    // ADR 0003's canonical form, plain and revision-pinned. `profileId` is null
    // because a model reference selects no product mode — recording one would be
    // the invention this whole column exists to prevent.
    expect(classifyRequestedModel('qwen/qwen3-32b')).toEqual({
      id: 'qwen/qwen3-32b',
      kind: 'model_reference',
      profileId: null,
    });
    expect(classifyRequestedModel('qwen/qwen3-32b@2026-01-01').kind).toBe('model_reference');
  });

  it('reads removed Alia provider aliases as unregistered', () => {
    for (const removed of ['alia-lite', 'alia-v1', 'alia-v1-pro', 'alia-v1-voice']) {
      expect(classifyRequestedModel(removed), removed).toEqual({
        id: removed,
        kind: 'unregistered',
        profileId: null,
      });
    }
  });

  it('reads a profile: id nobody serves as unregistered', () => {
    // Well-formed and unknown. Without the membership check, "a product mode was
    // requested" would be satisfiable by a caller inventing one.
    expect(classifyRequestedModel('profile:v9-imaginary')).toEqual({
      id: 'profile:v9-imaginary',
      kind: 'unregistered',
      profileId: null,
    });
  });

  it('reads anything else as unregistered rather than throwing', () => {
    // An analytics write must never be able to fail a request, and "the caller
    // asked for something we do not serve" is itself worth counting.
    for (const junk of ['', 'gpt-4o', 'auto', '///', 'profile:', 'a b c']) {
      expect(classifyRequestedModel(junk).kind, junk).toBe('unregistered');
    }
  });

  it('never returns a profile id for a kind that has no profile', () => {
    // The invariant across the whole set, stated once: a null `kind` pairing
    // would let a query group model references under a product mode.
    for (const requested of ['qwen/qwen3-32b', 'alia-v1', 'gpt-4o']) {
      expect(classifyRequestedModel(requested).profileId, requested).toBeNull();
    }
  });
});

describe('reasoningEffortOf', () => {
  it('reads the legacy thinkingMode flag as the smallest budget', () => {
    // Not a higher level: the boolean meant "reason" against a path that sent
    // NO budget at all, so the smallest is the only reading that cannot raise
    // an existing caller's bill without them asking for it.
    expect(reasoningEffortOf({ thinkingMode: true, requestedModel: 'kaana-v1' })).toBe('medium');
  });

  it('reads the canonical profile whose product meaning includes reasoning', () => {
    expect(reasoningEffortOf({ requestedModel: 'kaana-v1-thinking' })).toBe('medium');
  });

  it('reads an explicit level, and prefers it over the legacy spellings', () => {
    expect(reasoningEffortOf({ reasoningEffort: 'max', requestedModel: 'kaana-v1' })).toBe('max');
    expect(reasoningEffortOf({ reasoningEffort: 'instant', requestedModel: 'kaana-v1-thinking' })).toBe('instant');
    expect(reasoningEffortOf({ reasoningEffort: 'high', thinkingMode: true, requestedModel: 'kaana-v1' })).toBe('high');
  });

  it('refuses a level it does not offer, rather than passing it through', () => {
    // The request body is untrusted. A string that reached `providerOptions`
    // unchecked would be a caller choosing a provider parameter directly.
    expect(reasoningEffortOf({ reasoningEffort: 'ludicrous', requestedModel: 'kaana-v1' })).toBeNull();
    expect(reasoningEffortOf({ reasoningEffort: 'extended', requestedModel: 'kaana-v1' })).toBeNull();
    expect(reasoningEffortOf({ reasoningEffort: 7, requestedModel: 'kaana-v1' })).toBeNull();
    expect(reasoningEffortOf({ reasoningEffort: '__proto__', requestedModel: 'kaana-v1' })).toBeNull();
  });

  it('that routing profile really is a second name for another preset, not a model', () => {
    // What makes the line above correct rather than a guess. If
    // `kaana-v1-thinking` ever stops sharing a preset with `kaana-v1-pro-max` it
    // has become a model, and lifting its reasoning out would be wrong.
    const preset = ROUTING_PRESETS.find((entry) => entry.profileIds.includes('kaana-v1-thinking'));
    expect(preset?.profileIds).toEqual(['kaana-v1-pro-max', 'kaana-v1-thinking']);
  });

  it('is null for an ordinary request', () => {
    // The discriminator. Without it, every assertion above is also satisfied by
    // a function that returns a level unconditionally.
    expect(reasoningEffortOf({ requestedModel: 'kaana-v1' })).toBeNull();
    expect(reasoningEffortOf({ thinkingMode: false, requestedModel: 'kaana-v1-pro' })).toBeNull();
    expect(reasoningEffortOf({ requestedModel: 'profile:v1-pro-max' })).toBeNull();
  });

  it('the effort vocabulary is exactly four levels, and a UI may not offer more', () => {
    /**
     * The ceiling on how many levels a picker can honestly show.
     *
     * This assertion used to read `['extended']`, and the paragraph under it
     * explained why a four-level control would be dishonest: `thinkingMode` was
     * a BOOLEAN, and the one thing it was supposed to do — send a provider
     * option — it did not do either, because `lib/chat/model-config.ts` wrote
     * AI SDK **v4** option names against an `ai@6` install.
     *
     * Both conditions it named have now landed, which is why the number moved:
     *
     *  1. the options go under `providerOptions`, asserted against the
     *     installed packages in
     *     `lib/chat/__tests__/reasoning-provider-options.test.ts`;
     *  2. a LEVEL replaced the boolean, and `lib/catalogue.ts` publishes per
     *     entry which levels EVERY candidate route can honour.
     *
     * The ceiling itself is unchanged in spirit and is what stops a fifth label
     * appearing in a picker with nothing behind it.
     *
     * ## Read off the TYPE, not off sampled calls
     *
     * The first version of this test collected `reasoningEffortOf` over four
     * hand-picked inputs and asserted the resulting set. It SURVIVED the
     * mutation it exists to catch: adding a level to the union and returning it
     * for `pro-max` left all four samples unchanged, because none of them was a
     * `pro-max` id. A census over chosen inputs measures the inputs.
     */
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages/api/src/lib/reasoning-effort.ts'),
      'utf8',
    );
    const declaration = /export const EFFORT_LEVELS = \[([^\]]+)\] as const;/.exec(source);
    // Positive control: a renamed or reformatted declaration must fail loudly
    // rather than leave the assertion below reading `undefined`.
    expect(declaration, 'EFFORT_LEVELS is no longer declared in the expected shape').not.toBeNull();

    const levels = (declaration?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((part) => part.length > 0);
    expect(levels).toEqual(['instant', 'medium', 'high', 'max']);
    // The runtime constant and the source text are the same four, so a level
    // added to one and not the other fails rather than half-shipping.
    expect([...EFFORT_LEVELS]).toEqual(levels);

    // And the runtime agrees: the legacy spellings produce exactly `medium` or
    // nothing, across the whole profile table. This half is what catches a level
    // reachable without widening the vocabulary.
    const observed = new Set(
      ROUTING_PRESETS.flatMap((preset) => preset.profileIds).flatMap((profileId) => [
        String(reasoningEffortOf({ thinkingMode: true, requestedModel: profileId })),
        String(reasoningEffortOf({ thinkingMode: false, requestedModel: profileId })),
        String(reasoningEffortOf({ requestedModel: profileId })),
      ]),
    );
    expect([...observed].sort()).toEqual(['medium', 'null']);
  });
});
