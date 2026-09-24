import { describe, expect, it } from 'vitest';

import {
  FEATURED_LIMIT,
  UTILITY_MIN_CONTEXT,
  blendedPrice,
  selectDefaultModelId,
  selectFeatured,
  selectSpeechModelId,
  selectUtilityModelId,
} from '../auto-selection.js';
import type { CatalogueModel } from '../catalogue.js';

/** A chat-usable model; every test states only what it varies. */
function model(id: string, overrides: Partial<CatalogueModel> = {}): CatalogueModel {
  const publisher = id.slice(0, id.indexOf('/'));
  return {
    id,
    name: id,
    publisher: { id: publisher, name: publisher.toUpperCase() },
    description: null,
    contextWindow: 128_000,
    maxOutput: 8_000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: [],
    pricing: { inputPerMTok: '1', outputPerMTok: '2' },
    releasedAt: '2026-01-01',
    ...overrides,
  };
}

describe('selectFeatured', () => {
  it('features each publisher’s newest chat-usable model', () => {
    const models = [
      model('a/old', { releasedAt: '2025-01-01' }),
      model('a/new', { releasedAt: '2026-06-01' }),
      model('a/newest-no-tools', { releasedAt: '2026-09-01', tools: false }),
      model('b/only', { releasedAt: '2026-02-01' }),
    ];
    expect(selectFeatured(models, []).sort()).toEqual(['a/new', 'b/only']);
  });

  it('ranks publishers by what Alia’s users ran, across all their models', () => {
    const models = [
      model('a/new', { releasedAt: '2026-06-01' }),
      model('a/old', { releasedAt: '2025-01-01' }),
      model('b/new', { releasedAt: '2026-07-01' }),
    ];
    // Publisher a's usage is on its OLD model; its newest still leads its slot.
    expect(selectFeatured(models, [{ modelId: 'a/old', turns: 50 }, { modelId: 'b/new', turns: 10 }]))
      .toEqual(['a/new', 'b/new']);
  });

  it('falls back to recency on a cold start, and caps the list', () => {
    const models = Array.from({ length: FEATURED_LIMIT + 3 }, (_, i) =>
      model(`p${String(i).padStart(2, '0')}/m`, { releasedAt: `2026-01-${String(i + 1).padStart(2, '0')}` }),
    );
    const featured = selectFeatured(models, []);
    expect(featured).toHaveLength(FEATURED_LIMIT);
    expect(featured[0]).toBe(`p${String(FEATURED_LIMIT + 2).padStart(2, '0')}/m`);
  });

  it('puts an undated model after dated ones', () => {
    expect(selectFeatured([model('a/undated', { releasedAt: null }), model('a/dated')], [])).toEqual(['a/dated']);
  });
});

describe('selectDefaultModelId', () => {
  const models = [
    model('a/cheap', { pricing: { inputPerMTok: '0.1', outputPerMTok: '0.2' } }),
    model('b/dear', { pricing: { inputPerMTok: '10', outputPerMTok: '30' } }),
    model('c/unfeatured', { pricing: { inputPerMTok: '0.01', outputPerMTok: '0.01' } }),
  ];
  const featuredIds = ['b/dear', 'a/cheap'];

  it('is the person’s last-used model while it is still offered', () => {
    expect(selectDefaultModelId({ models, featuredIds, usage: [], lastUsedModelId: 'c/unfeatured' })).toBe('c/unfeatured');
  });

  it('ignores a last-used model the catalogue no longer offers', () => {
    expect(selectDefaultModelId({ models, featuredIds, usage: [], lastUsedModelId: 'gone/model' })).toBe('a/cheap');
  });

  it('is the most-used featured model for a new person', () => {
    expect(selectDefaultModelId({
      models,
      featuredIds,
      usage: [{ modelId: 'b/dear', turns: 9 }, { modelId: 'a/cheap', turns: 3 }, { modelId: 'c/unfeatured', turns: 99 }],
    })).toBe('b/dear');
  });

  it('is the cheapest featured model on a cold start', () => {
    expect(selectDefaultModelId({ models, featuredIds, usage: [] })).toBe('a/cheap');
  });

  it('falls back to the cheapest chat model with nothing featured, and null with nothing at all', () => {
    expect(selectDefaultModelId({ models, featuredIds: [], usage: [] })).toBe('c/unfeatured');
    expect(selectDefaultModelId({ models: [], featuredIds: [], usage: [] })).toBeNull();
  });
});

describe('selectUtilityModelId', () => {
  it('is the cheapest chat model with enough context', () => {
    expect(selectUtilityModelId([
      model('a/tiny', { contextWindow: UTILITY_MIN_CONTEXT - 1, pricing: { inputPerMTok: '0.01', outputPerMTok: '0.01' } }),
      model('b/ok', { pricing: { inputPerMTok: '0.5', outputPerMTok: '1' } }),
      model('c/dear'),
      model('d/no-tools', { tools: false, pricing: { inputPerMTok: '0', outputPerMTok: '0' } }),
    ])).toBe('b/ok');
  });

  it('never prefers an unpriced model over a priced one', () => {
    expect(selectUtilityModelId([model('a/unpriced', { pricing: null }), model('b/priced')])).toBe('b/priced');
    expect(blendedPrice(model('a/unpriced', { pricing: null }))).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses a model of unknown context only when none reports one', () => {
    expect(selectUtilityModelId([model('a/unknown', { contextWindow: null })])).toBe('a/unknown');
    expect(selectUtilityModelId([])).toBeNull();
  });
});

describe('selectSpeechModelId', () => {
  it('is the cheapest model with audio output', () => {
    expect(selectSpeechModelId([
      model('a/chat'),
      model('b/voice-dear', { outputModalities: ['audio'], tools: false, pricing: { inputPerMTok: '5', outputPerMTok: '5' } }),
      model('c/voice-cheap', { outputModalities: ['audio'], tools: false, pricing: { inputPerMTok: '1', outputPerMTok: '1' } }),
    ])).toBe('c/voice-cheap');
    expect(selectSpeechModelId([model('a/chat')])).toBeNull();
  });
});
