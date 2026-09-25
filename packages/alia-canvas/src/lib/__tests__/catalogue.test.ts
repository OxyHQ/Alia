import { describe, expect, it } from 'vitest';

import {
  defaultLabel,
  formatContextWindow,
  groupModels,
  isModelId,
  labelForNode,
  parseCatalogue,
  storedModelId,
  withStoredModels,
} from '../catalogue';

/**
 * The canvas model picker reads real models from `GET /catalogue` and nothing
 * else: no id is named in the source, a node with no choice stores no `model`,
 * and a retired non-model identifier in a saved workflow reads as no choice.
 * Fixture ids are invented on purpose — they only have to be `publisher/model`.
 */

const model = (over: Record<string, unknown> = {}) => ({
  id: 'acme/rocket-1',
  object: 'model',
  name: 'Rocket 1',
  publisher: { id: 'acme', name: 'Acme' },
  description: null,
  contextWindow: 200_000,
  maxOutput: null,
  inputModalities: ['text'],
  outputModalities: ['text'],
  tools: true,
  reasoningEfforts: [],
  pricing: null,
  releasedAt: null,
  featured: false,
  ...over,
});

const body = (data: unknown[], extra: Record<string, unknown> = {}) => ({
  object: 'list',
  data,
  defaultModelId: 'acme/rocket-1',
  featuredIds: [],
  ...extra,
});

describe('parseCatalogue', () => {
  it('reads models, the server default and the featured ids', () => {
    const catalogue = parseCatalogue(
      body([model(), model({ id: 'zeta/bolt', name: 'Bolt', publisher: { id: 'zeta', name: 'Zeta' } })], {
        featuredIds: ['zeta/bolt'],
      }),
    );
    expect(catalogue.models.map((m) => m.id)).toEqual(['acme/rocket-1', 'zeta/bolt']);
    expect(catalogue.defaultModelId).toBe('acme/rocket-1');
    expect(catalogue.featuredIds).toEqual(['zeta/bolt']);
    expect(catalogue.models[0]).toMatchObject({ contextWindow: 200_000, publisher: { name: 'Acme' } });
  });

  it('drops entries that are not models or not `publisher/model`', () => {
    const catalogue = parseCatalogue(body([model(), model({ id: 'no-slash' }), model({ object: 'routing_profile', id: 'x/y' })]));
    expect(catalogue.models.map((m) => m.id)).toEqual(['acme/rocket-1']);
  });

  it('throws when nothing is readable, rather than reading as an empty catalogue', () => {
    expect(() => parseCatalogue({ nope: true })).toThrow('could not be read');
    expect(() => parseCatalogue(body([{ id: 'a/b' }, { nope: 1 }]))).toThrow('could not be read');
  });

  it('accepts a genuinely empty catalogue and a missing default', () => {
    expect(parseCatalogue({ object: 'list', data: [] })).toEqual({ models: [], defaultModelId: null, featuredIds: [] });
  });
});

describe('groupModels', () => {
  const catalogue = parseCatalogue(
    body(
      [
        model({ id: 'zeta/bolt', name: 'Bolt', publisher: { id: 'zeta', name: 'Zeta' } }),
        model({ id: 'acme/rocket-1' }),
        model({ id: 'beta/wing', name: 'Wing', publisher: { id: 'beta', name: 'beta labs' } }),
        model({ id: 'acme/rocket-2', name: 'Rocket 2', featured: true }),
      ],
      { featuredIds: ['acme/rocket-2', 'zeta/bolt'] },
    ),
  );

  it('puts featured first in featuredIds order, then publishers alphabetically', () => {
    const groups = groupModels(catalogue);
    expect(groups.map((g) => g.label)).toEqual([null, 'Acme', 'beta labs']);
    expect(groups[0].models.map((m) => m.id)).toEqual(['acme/rocket-2', 'zeta/bolt']);
    expect(groups[1].models.map((m) => m.id)).toEqual(['acme/rocket-1']);
  });

  it('falls back to the per-entry flag when featuredIds is empty', () => {
    const groups = groupModels({ ...catalogue, featuredIds: [] });
    expect(groups[0].models.map((m) => m.id)).toEqual(['acme/rocket-2']);
  });
});

describe('a stored node model', () => {
  it('is only ever a `publisher/model` id; anything else is the server default', () => {
    expect(storedModelId('acme/rocket-1')).toBe('acme/rocket-1');
    for (const retired of ['mode' + ':auto', 'route' + ':instant', 'profile' + ':fast', '', ' a/b', undefined, null]) {
      expect(storedModelId(retired), String(retired)).toBeUndefined();
    }
    expect(isModelId('/x')).toBe(false);
    expect(isModelId('x/')).toBe(false);
  });

  it('is stripped from nodes loaded or sent when it is not a model id', () => {
    const nodes = [
      { id: 'a', data: { label: 'A', model: 'route' + ':instant' } },
      { id: 'b', data: { label: 'B', model: 'acme/rocket-1' } },
      { id: 'c', data: { label: 'C' } },
    ];
    const cleaned = withStoredModels(nodes);
    expect(cleaned[0].data).toEqual({ label: 'A' });
    expect(cleaned[1]).toBe(nodes[1]);
    expect(cleaned[2]).toBe(nodes[2]);
  });
});

describe('labels', () => {
  const catalogue = parseCatalogue(body([model()]));

  it('names the default model when the node names none', () => {
    expect(labelForNode(undefined, catalogue)).toBe('Default (Rocket 1)');
    expect(labelForNode('mode' + ':pro', catalogue)).toBe('Default (Rocket 1)');
    expect(defaultLabel({ ...catalogue, defaultModelId: null })).toBe('Default');
  });

  it('names a chosen model, or shows its id when the catalogue no longer lists it', () => {
    expect(labelForNode('acme/rocket-1', catalogue)).toBe('Rocket 1');
    expect(labelForNode('gone/model', catalogue)).toBe('gone/model');
    expect(labelForNode(undefined, undefined)).toBeNull();
  });

  it('formats a context window compactly', () => {
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(1_048_576)).toBe('1M');
    expect(formatContextWindow(null)).toBeNull();
  });
});
