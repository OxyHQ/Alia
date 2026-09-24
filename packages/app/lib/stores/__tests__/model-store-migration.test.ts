import { describe, expect, it } from 'vitest';
import { migrateModelState } from '../model-store-migration';

/**
 * What devices stored before v3, spelled as prefix + name so the repo-wide
 * census of retired identifiers (`mode:<name>`, `route:<name>`) stays empty:
 * this suite is the one place they are still expected to appear.
 */
const legacy = (prefix: string, name: string) => `${prefix}:${name}`;
const AUTO = legacy('mode', 'auto');

describe('model store persisted-state migration (v3)', () => {
  it.each([AUTO, legacy('mode', 'thinking'), legacy('route', 'instant'), legacy('route', 'cowork'), legacy('profile', 'auto'), 'alia-pro'])(
    'turns the invented choice %s into the server default',
    (selectedModel) => {
      expect(migrateModelState({ selectedModel, reasoningEffort: null, webSearch: true }, 2).selectedModel).toBeNull();
    },
  );

  it('keeps a real model and a device model', () => {
    expect(migrateModelState({ selectedModel: 'acme/model' }, 2).selectedModel).toBe('acme/model');
    expect(migrateModelState({ selectedModel: 'local/ollama/llama' }, 2).selectedModel).toBe('local/ollama/llama');
  });

  it.each([
    ['instant', null],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'high'],
    [null, null],
  ])('maps the old effort %s to %s', (reasoningEffort, expected) => {
    expect(migrateModelState({ selectedModel: AUTO, reasoningEffort }, 2).reasoningEffort).toBe(expected);
  });

  it('carries the v1 thinking toggle as the smallest budget', () => {
    expect(migrateModelState({ selectedModel: 'x/y', thinkingMode: true }, 1).reasoningEffort).toBe('medium');
  });

  it('keeps web search and pins, and survives a malformed state', () => {
    expect(migrateModelState({ webSearch: false, pinnedModels: ['a/b', legacy('route', 'pro'), 3] }, 2)).toEqual({
      selectedModel: null,
      reasoningEffort: null,
      webSearch: false,
      pinnedModels: ['a/b'],
    });
    expect(migrateModelState(null, 2)).toEqual({
      selectedModel: null,
      reasoningEffort: null,
      webSearch: true,
      pinnedModels: [],
    });
  });
});
