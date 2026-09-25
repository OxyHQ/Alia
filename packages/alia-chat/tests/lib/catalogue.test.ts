import { describe, expect, it } from 'vitest';
import { parseCatalogue, resolveSelection } from '../../src/lib/catalogue';

const wire = {
  object: 'list',
  defaultModelId: 'acme/fast',
  featuredIds: ['acme/smart'],
  data: [
    {
      id: 'acme/fast',
      object: 'model',
      name: 'Fast',
      publisher: { id: 'acme', name: 'Acme' },
      description: null,
      contextWindow: 128000,
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
      description: 'Thinks',
      contextWindow: null,
      maxOutput: 8000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: ['high', 'low', 'extreme'],
      pricing: { inputPerMTok: '1.00', outputPerMTok: '4.00' },
      releasedAt: '2026-01-01T00:00:00Z',
      featured: true,
    },
    { object: 'model', name: 'no id' },
  ],
};

describe('parseCatalogue', () => {
  it('reads real models, the server default and the featured order', () => {
    const catalogue = parseCatalogue(wire);
    expect(catalogue.defaultModelId).toBe('acme/fast');
    expect(catalogue.featuredIds).toEqual(['acme/smart']);
    expect(catalogue.entries.map((entry) => entry.id)).toEqual(['acme/fast', 'acme/smart']);
    const smart = catalogue.entries[1]!;
    // Unknown levels are dropped and the known ones come back cheapest first.
    expect(smart.reasoningEfforts).toEqual(['low', 'high']);
    expect(smart.pricing).toEqual({ inputPerMTok: '1.00', outputPerMTok: '4.00' });
    expect(smart.publisher).toEqual({ id: 'acme', name: 'Acme' });
  });

  it('throws on a response it cannot read rather than offering nothing', () => {
    expect(() => parseCatalogue({})).toThrow();
    expect(() => parseCatalogue({ data: [{ nope: true }] })).toThrow();
    expect(parseCatalogue({ data: [] }).entries).toEqual([]);
  });
});

describe('resolveSelection', () => {
  const catalogue = parseCatalogue(wire);

  it('omits the model when nothing was chosen, so the server default answers', () => {
    const selection = resolveSelection(undefined, catalogue);
    expect(selection.effectiveId).toBeUndefined();
    expect(selection.entry?.id).toBe('acme/fast');
  });

  it('sends a listed model as is', () => {
    expect(resolveSelection('acme/smart', catalogue).effectiveId).toBe('acme/smart');
  });

  it('does not send a model the catalogue no longer lists', () => {
    const selection = resolveSelection('gone/model', catalogue);
    expect(selection.source).toBe('replaced');
    expect(selection.effectiveId).toBeUndefined();
  });

  it('leaves the choice alone while the catalogue is unknown', () => {
    expect(resolveSelection('acme/smart', undefined).effectiveId).toBe('acme/smart');
  });
});
