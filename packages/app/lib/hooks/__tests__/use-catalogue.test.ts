import { describe, expect, it, vi } from 'vitest';

// The module's query half reaches the network and Bloom's raw source; only its
// pure functions are under test here.
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ user: null }) }));
vi.mock('@/lib/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { parseCatalogue, resolveSelection } from '../use-catalogue';

const wire = {
  object: 'list',
  defaultModelId: 'acme/fast',
  featuredIds: ['acme/smart', 'nope/missing'],
  data: [
    {
      id: 'acme/fast',
      object: 'model',
      name: 'Fast',
      publisher: { id: 'acme', name: 'Acme' },
      description: null,
      contextWindow: 131072,
      maxOutput: null,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: [],
      pricing: null,
      releasedAt: null,
      featured: false,
    },
    {
      id: 'acme/smart',
      object: 'model',
      name: 'Smart',
      publisher: { id: 'acme', name: 'Acme' },
      description: 'Thinks first',
      contextWindow: null,
      maxOutput: 32000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: ['high', 'minimal', 'low'],
      pricing: { inputPerMTok: '1.25', outputPerMTok: '10.00' },
      releasedAt: '2026-08-01T00:00:00Z',
      featured: true,
    },
    { id: 'broken/entry', object: 'model' },
  ],
};

describe('parseCatalogue', () => {
  it('reads the real models, the server default and the featured order', () => {
    const catalogue = parseCatalogue(wire);
    expect(catalogue.defaultModelId).toBe('acme/fast');
    expect(catalogue.featuredIds).toEqual(['acme/smart', 'nope/missing']);
    expect(catalogue.entries.map((entry) => entry.id)).toEqual(['acme/fast', 'acme/smart']);
    expect(catalogue.entries[1]).toMatchObject({
      name: 'Smart',
      publisher: { id: 'acme', name: 'Acme' },
      maxOutput: 32000,
      // Cheapest first, and a level this client has no words for is dropped.
      reasoningEfforts: ['low', 'high'],
      pricing: { inputPerMTok: '1.25', outputPerMTok: '10.00' },
      featured: true,
    });
  });

  it('throws on a response it cannot read, rather than offering nothing', () => {
    expect(() => parseCatalogue(null)).toThrow();
    expect(() => parseCatalogue({ data: [{ id: 'x' }] })).toThrow();
    expect(parseCatalogue({ data: [] }).entries).toEqual([]);
  });
});

describe('resolveSelection', () => {
  const catalogue = parseCatalogue(wire);

  it('sends no model when nothing is chosen, and shows the server default', () => {
    expect(resolveSelection(null, catalogue)).toMatchObject({
      shownId: 'acme/fast',
      effectiveId: null,
      source: 'default',
    });
  });

  it('sends a listed model as chosen', () => {
    const selection = resolveSelection('acme/smart', catalogue);
    expect(selection.effectiveId).toBe('acme/smart');
    expect(selection.entry?.name).toBe('Smart');
  });

  it('does not send a model the catalogue no longer lists', () => {
    expect(resolveSelection('gone/model', catalogue)).toMatchObject({
      shownId: 'acme/fast',
      effectiveId: null,
      source: 'replaced',
    });
  });

  it('sends a connected device model, and leaves a choice alone while the catalogue is unknown', () => {
    expect(resolveSelection('local/ollama/llama', catalogue, ['local/ollama/llama']).effectiveId).toBe(
      'local/ollama/llama',
    );
    expect(resolveSelection('acme/smart', undefined).effectiveId).toBe('acme/smart');
  });
});
