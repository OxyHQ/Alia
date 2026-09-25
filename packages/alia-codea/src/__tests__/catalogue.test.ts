/**
 * The extension reads the real-model catalogue and never invents a model.
 *
 * The payload follows the `GET /catalogue` wire: `{ object, data, defaultModelId,
 * featuredIds }`, each entry a `publisher/model`.
 */

import { describe, expect, it } from 'vitest';
import { parseCatalogue, pickerCatalogue, resolveSelection } from '../catalogue';

const CATALOGUE = {
  object: 'list',
  defaultModelId: 'acme/swift-2',
  featuredIds: ['zeta/deep-1', 'acme/swift-2'],
  data: [
    {
      id: 'acme/swift-2',
      object: 'model',
      name: 'Swift 2',
      publisher: { id: 'acme', name: 'Acme' },
      description: 'Fast general model',
      contextWindow: 128000,
      maxOutput: 8192,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: [],
      pricing: { inputPerMTok: '0.10', outputPerMTok: '0.40' },
      releasedAt: '2026-05-01',
      featured: true,
    },
    {
      id: 'acme/atlas',
      object: 'model',
      name: 'Atlas',
      publisher: { id: 'acme', name: 'Acme' },
      description: null,
      contextWindow: null,
      maxOutput: null,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: false,
      reasoningEfforts: ['low', 'high', 'extreme'],
      pricing: null,
      releasedAt: null,
      featured: false,
    },
    {
      id: 'beta/coder',
      object: 'model',
      name: 'Coder',
      publisher: { id: 'beta', name: 'Beta Labs' },
      description: 'Code model',
      contextWindow: 200000,
      maxOutput: null,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: ['medium'],
      pricing: null,
      releasedAt: null,
      featured: false,
    },
    {
      id: 'zeta/deep-1',
      object: 'model',
      name: 'Deep 1',
      publisher: { id: 'zeta', name: 'Zeta' },
      description: 'Reasoning model',
      contextWindow: 1000000,
      maxOutput: 32000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      pricing: { inputPerMTok: '3', outputPerMTok: '15' },
      releasedAt: '2026-08-01',
      featured: true,
    },
  ],
};

const catalogue = parseCatalogue(CATALOGUE);

describe('parseCatalogue', () => {
  it('reads every entry, the server default and the featured ids', () => {
    expect(catalogue.models.map((m) => m.id)).toEqual([
      'acme/swift-2',
      'acme/atlas',
      'beta/coder',
      'zeta/deep-1',
    ]);
    expect(catalogue.defaultModelId).toBe('acme/swift-2');
    expect(catalogue.featuredIds).toEqual(['zeta/deep-1', 'acme/swift-2']);
    expect(catalogue.models[0]).toMatchObject({
      name: 'Swift 2',
      publisher: { id: 'acme', name: 'Acme' },
      contextWindow: 128000,
      tools: true,
      pricing: { inputPerMTok: '0.10', outputPerMTok: '0.40' },
    });
  });

  it('keeps only the reasoning efforts it knows', () => {
    expect(catalogue.models[1].reasoningEfforts).toEqual(['low', 'high']);
  });

  it('drops an entry with no id or name, or of another object type', () => {
    const parsed = parseCatalogue({
      object: 'list',
      data: [
        { id: 'x/y', object: 'model' },
        { object: 'model', name: 'Nameless' },
        { id: 'old:thing', object: 'routing_profile', name: 'Old' },
        CATALOGUE.data[0],
      ],
    });
    expect(parsed.models.map((m) => m.id)).toEqual(['acme/swift-2']);
    expect(parsed.defaultModelId).toBeNull();
    expect(parsed.featuredIds).toEqual([]);
  });

  it('throws rather than reading an unreadable response as "no models"', () => {
    expect(() => parseCatalogue({ object: 'list' })).toThrow();
    expect(() => parseCatalogue({ object: 'list', data: [{ id: 'x/y' }] })).toThrow();
  });

  it('reads an empty list as an empty catalogue', () => {
    expect(parseCatalogue({ object: 'list', data: [] }).models).toEqual([]);
  });
});

describe('resolveSelection', () => {
  it('omits the model when nothing is configured', () => {
    expect(resolveSelection('', catalogue)).toBeUndefined();
    expect(resolveSelection('   ', catalogue)).toBeUndefined();
    expect(resolveSelection(undefined, catalogue)).toBeUndefined();
    expect(resolveSelection('', undefined)).toBeUndefined();
  });

  it('sends a configured model the catalogue lists', () => {
    expect(resolveSelection('beta/coder', catalogue)).toBe('beta/coder');
  });

  it('omits a configured model the catalogue no longer lists', () => {
    expect(resolveSelection('gone/model', catalogue)).toBeUndefined();
  });

  it('sends the configured id as-is when there is no catalogue', () => {
    expect(resolveSelection('gone/model', undefined)).toBe('gone/model');
  });
});

describe('pickerCatalogue', () => {
  it('puts featured models first, in server order, then groups the rest by publisher', () => {
    const picker = pickerCatalogue(catalogue);
    expect(picker.groups.map((g) => g.title)).toEqual(['Featured', 'Acme', 'Beta Labs']);
    expect(picker.groups[0].models.map((m) => m.id)).toEqual(['zeta/deep-1', 'acme/swift-2']);
    expect(picker.groups[1].models.map((m) => m.id)).toEqual(['acme/atlas']);
  });

  it('labels a row "Name — Publisher" and names the server default', () => {
    const picker = pickerCatalogue(catalogue);
    expect(picker.groups[0].models[0]).toEqual({
      id: 'zeta/deep-1',
      label: 'Deep 1 — Zeta',
      description: 'Reasoning model · 1000K context',
    });
    expect(picker.defaultLabel).toBe('Default (Swift 2)');
  });

  it('falls back to the entries flagged featured when featuredIds is absent', () => {
    const picker = pickerCatalogue({ ...catalogue, featuredIds: [] });
    expect(picker.groups[0].models.map((m) => m.id)).toEqual(['acme/swift-2', 'zeta/deep-1']);
  });
});
