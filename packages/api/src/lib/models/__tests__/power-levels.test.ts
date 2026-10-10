import { describe, expect, it, vi } from 'vitest';

vi.mock('../catalogue.js', () => ({
  isChatUsable: () => true,
  listCatalogueModels: async () => [],
}));
vi.mock('../selection.js', () => ({ getUtilityModelId: async () => 'acme/small-1' }));

import {
  DEFAULT_POWER_LEVEL,
  isPowerLevel,
  modelLineOf,
  POWER_LEVELS,
  servedModelId,
  servedReferenceOf,
} from '../power-levels.js';
import { resolveDefaultModel, resolveModel, resolveStoredModel } from '../../chat-core.js';
import { ModelNotFoundError } from '../errors.js';

describe('power levels (ADR 0014)', () => {
  it("are Oxy's seven slugs, none of them a model id", () => {
    expect(POWER_LEVELS).toEqual(['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra']);
    for (const level of POWER_LEVELS) expect(level).not.toContain('/');
    expect(DEFAULT_POWER_LEVEL).toBe('auto');
  });

  it.each(['max', 'mode:auto', 'route:pro', 'Auto', 'openai/gpt-5', '', null, 7])(
    'does not take %p for a level',
    (value) => {
      expect(isPowerLevel(value)).toBe(false);
    },
  );

  it('resolves a level to a routingProfile target with no catalogue entry', async () => {
    const resolved = await resolveModel('ultra');
    expect(resolved).toMatchObject({
      modelId: 'ultra',
      provider: 'kaana',
      powerLevel: 'ultra',
      catalogue: null,
      oxyInferenceTarget: { kind: 'routingProfile', routingProfile: 'ultra' },
    });
  });

  it('runs auto when nothing is named or stored, and a stored level as itself', async () => {
    expect(resolveDefaultModel().oxyInferenceTarget).toEqual({
      kind: 'routingProfile',
      routingProfile: 'auto',
    });
    expect((await resolveStoredModel(null)).powerLevel).toBe('auto');
    expect((await resolveStoredModel('instant')).powerLevel).toBe('instant');
    // A stored model the catalogue no longer carries falls back to auto too.
    expect((await resolveStoredModel('acme/retired-1')).powerLevel).toBe('auto');
  });

  it('still refuses an id that is neither a level nor a catalogue model', async () => {
    await expect(resolveModel('acme/nothing')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('prices and records a turn by the model Oxy says ran', () => {
    expect(modelLineOf('openai/gpt-5.5@2026-09-01')).toBe('openai/gpt-5.5');
    expect(modelLineOf('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(modelLineOf('auto')).toBeNull();
    expect(modelLineOf(null)).toBeNull();
    expect(servedModelId('high', 'google/gemini-3.7-flash@r1')).toBe('google/gemini-3.7-flash');
    // Nothing reported (a failed turn, a local model): what was asked for.
    expect(servedModelId('high', null)).toBe('high');
    expect(
      servedReferenceOf({ providerMetadata: { kaana: { resolvedModelReference: 'a/b@1' } } }),
    ).toBe('a/b@1');
    expect(servedReferenceOf({})).toBeNull();
  });
});
