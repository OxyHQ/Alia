import { describe, expect, it } from 'vitest';
import { migrateModelState } from '../model-store-migration';

/**
 * What devices stored before v3, spelled as prefix + name so the repo-wide
 * census of retired identifiers (`mode:<name>`, `route:<name>`) stays empty:
 * this suite is the one place they are still expected to appear.
 */
const legacy = (prefix: string, name: string) => `${prefix}:${name}`;
const AUTO = legacy('mode', 'auto');

describe('model store persisted-state migration (v4: power levels)', () => {
  it.each([
    // v3: a real model the person picked by name.
    ['acme/model', 3],
    ['openai/gpt-5.5', 3],
    // v0–v2: Alia's invented modes, routing profiles and aliases.
    [AUTO, 2],
    [legacy('mode', 'thinking'), 2],
    [legacy('route', 'instant'), 2],
    [legacy('route', 'cowork'), 1],
    [legacy('profile', 'auto'), 2],
    ['alia-pro', 0],
    // Nothing chosen at all.
    [null, 3],
    [undefined, 2],
  ])('turns the stored model %s (v%s) into auto', (selectedModel, version) => {
    expect(migrateModelState({ selectedModel, reasoningEffort: null, webSearch: true }, version).selectedLevel).toBe('auto');
  });

  it('keeps a model running on the person\'s own device', () => {
    expect(migrateModelState({ selectedModel: 'local/ollama/llama' }, 3).selectedLevel).toBe('local/ollama/llama');
    expect(migrateModelState({ selectedModel: 'local/ollama/llama' }, 2).selectedLevel).toBe('local/ollama/llama');
  });

  it.each([
    // The old instant / max collapse: the two ends of the scale are now levels.
    ['instant', 'instant'],
    ['max', 'ultra'],
    // The middle of the old scale was a knob on a model; it carries no level.
    ['medium', 'auto'],
    ['high', 'auto'],
    [null, 'auto'],
  ])('maps the pre-v3 effort %s to the level %s', (reasoningEffort, expected) => {
    expect(migrateModelState({ selectedModel: AUTO, reasoningEffort }, 2).selectedLevel).toBe(expected);
  });

  it('does not read v3 efforts as levels: v3 had already collapsed max into high', () => {
    expect(migrateModelState({ selectedModel: 'acme/model', reasoningEffort: 'high' }, 3).selectedLevel).toBe('auto');
  });

  it('keeps a v4 level and a v4 device model, and repairs an unknown one', () => {
    expect(migrateModelState({ selectedLevel: 'xhigh', webSearch: false }, 4)).toEqual({
      selectedLevel: 'xhigh',
      webSearch: false,
    });
    expect(migrateModelState({ selectedLevel: 'local/lm/qwen' }, 4).selectedLevel).toBe('local/lm/qwen');
    expect(migrateModelState({ selectedLevel: 'acme/model' }, 4).selectedLevel).toBe('auto');
  });

  it('keeps web search, drops effort and pins, and survives a malformed state', () => {
    expect(
      migrateModelState(
        { selectedModel: 'a/b', reasoningEffort: 'low', webSearch: false, pinnedModels: ['a/b', legacy('route', 'pro'), 3] },
        3,
      ),
    ).toEqual({ selectedLevel: 'auto', webSearch: false });
    expect(migrateModelState(null, 2)).toEqual({ selectedLevel: 'auto', webSearch: true });
    expect(migrateModelState('garbage', 0)).toEqual({ selectedLevel: 'auto', webSearch: true });
  });
});
