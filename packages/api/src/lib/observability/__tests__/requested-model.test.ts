import { describe, expect, it } from 'vitest';

import { ALIAS_TRANSLATIONS } from '../../routing/alias-translation.js';
import { ROUTING_PRESETS } from '../../routing/presets.js';
import { classifyRequestedModel, reasoningEffortOf } from '../requested-model.js';

/**
 * What the caller asked for, and what it IS — epic #139 workstream 5, *"Record
 * the requested model/profile ... in product analytics"*, read with the decision
 * that the thirteen `alia-*` identifiers leave every advertised surface while
 * continuing to resolve.
 *
 * The property under test is not "the classifier returns strings". It is that
 * the three shapes stay APART: a product mode, a concrete model reference and a
 * legacy alias are three different requests, and one `text` column recording
 * only the identifier makes them one. Each case below therefore pairs a shape
 * with a discriminator that fails if the classifier collapses it into another.
 */

describe('classifyRequestedModel', () => {
  it('reads all thirteen legacy aliases as aliases, not as product modes', () => {
    // Order matters in the implementation: every `alia-*` identifier is ALSO a
    // well-formed routing-profile slug, so a grammar-first reading would report
    // thirteen product modes Relay has never heard of. The whole set is checked
    // rather than a sample, because the failure is per-identifier.
    expect(ALIAS_TRANSLATIONS.length).toBe(13);
    for (const { alias, profileId } of ALIAS_TRANSLATIONS) {
      const identity = classifyRequestedModel(alias);
      expect(identity, alias).toEqual({ id: alias, kind: 'legacy_alias', profileId });
    }
  });

  it('reads a product mode as a product mode, and carries its own id through', () => {
    for (const preset of ROUTING_PRESETS) {
      expect(classifyRequestedModel(preset.id), preset.id).toEqual({
        id: preset.id,
        kind: 'routing_profile',
        profileId: preset.id,
      });
    }
  });

  it('puts an alias and the profile it becomes in the SAME profile column', () => {
    // The point of `profileId`: the two are one choice in two eras, and a query
    // that groups on this column sees them together without knowing the
    // migration map. The discriminator is `kind`, which still tells them apart.
    const alias = classifyRequestedModel('alia-v1-pro');
    const mode = classifyRequestedModel('profile:v1-pro');
    expect(alias.profileId).toBe(mode.profileId);
    expect(alias.kind).not.toBe(mode.kind);
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

  it('reads an unregistered alia-* identifier as unregistered, not as a profile', () => {
    // `alia-flash` is a well-formed routing-profile slug and nothing defines it.
    // Classifying it as a product mode would put an identifier in Alia's own
    // namespace on the wire that nothing has ever served.
    expect(classifyRequestedModel('alia-flash')).toEqual({
      id: 'alia-flash',
      kind: 'unregistered',
      profileId: null,
    });
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
    for (const requested of ['qwen/qwen3-32b', 'alia-flash', 'gpt-4o']) {
      expect(classifyRequestedModel(requested).profileId, requested).toBeNull();
    }
  });
});

describe('reasoningEffortOf', () => {
  it('reads the thinkingMode flag', () => {
    expect(reasoningEffortOf({ thinkingMode: true, requestedModel: 'alia-v1' })).toBe('extended');
  });

  it('reads the alias whose identity IS a reasoning setting', () => {
    expect(reasoningEffortOf({ requestedModel: 'alia-v1-thinking' })).toBe('extended');
  });

  it('that alias really is a second name for another preset, not a model', () => {
    // What makes the line above correct rather than a guess. If
    // `alia-v1-thinking` ever stops sharing a preset with `alia-v1-pro-max` it
    // has become a model, and lifting its reasoning out would be wrong.
    const preset = ROUTING_PRESETS.find((entry) => entry.aliases.includes('alia-v1-thinking'));
    expect(preset?.aliases).toEqual(['alia-v1-pro-max', 'alia-v1-thinking']);
  });

  it('is null for an ordinary request', () => {
    // The discriminator. Without it, every assertion above is also satisfied by
    // a function that returns `'extended'` unconditionally.
    expect(reasoningEffortOf({ requestedModel: 'alia-v1' })).toBeNull();
    expect(reasoningEffortOf({ thinkingMode: false, requestedModel: 'alia-v1-pro' })).toBeNull();
    expect(reasoningEffortOf({ requestedModel: 'profile:v1-pro-max' })).toBeNull();
  });
});
