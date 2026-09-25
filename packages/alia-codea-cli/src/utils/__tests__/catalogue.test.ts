/**
 * The CLI reads the real-model catalogue, never invents a model, and omits
 * `model` whenever the server's default should answer.
 */

import { describe, expect, it, vi } from 'vitest';

// `catalogue.ts` imports the on-disk config and the session; neither is
// exercised by the pure functions under test.
vi.mock('../config.js', () => ({ config: { get: () => 'https://api.example' } }));
vi.mock('../oxy-session.js', () => ({ accessToken: () => null }));

const {
  formatModelList,
  groupModels,
  labelForChoice,
  parseCatalogue,
  resolveSelection,
  searchModels,
} = await import('../catalogue.js');

function entry(
  id: string,
  name: string,
  publisher: [string, string],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    object: 'model',
    name,
    publisher: { id: publisher[0], name: publisher[1] },
    description: null,
    contextWindow: null,
    maxOutput: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: [],
    pricing: null,
    releasedAt: null,
    featured: false,
    ...extra,
  };
}

const PAYLOAD = {
  object: 'list',
  defaultModelId: 'acme/swift-2',
  featuredIds: ['zeta/deep-1', 'acme/swift-2'],
  data: [
    entry('acme/swift-2', 'Swift 2', ['acme', 'Acme'], { contextWindow: 128000, featured: true }),
    entry('acme/swift-2-mini', 'Swift 2 Mini', ['acme', 'Acme']),
    entry('beta/coder', 'Coder', ['beta', 'Beta Labs'], {
      contextWindow: 200000,
      reasoningEfforts: ['medium', 'max'],
    }),
    entry('zeta/deep-1', 'Deep 1', ['zeta', 'Zeta'], { contextWindow: 1000000, featured: true }),
  ],
};

const catalogue = parseCatalogue(PAYLOAD);

describe('parseCatalogue', () => {
  it('reads entries, the server default and the featured ids', () => {
    expect(catalogue.models.map((m) => m.id)).toEqual([
      'acme/swift-2',
      'acme/swift-2-mini',
      'beta/coder',
      'zeta/deep-1',
    ]);
    expect(catalogue.defaultModelId).toBe('acme/swift-2');
    expect(catalogue.featuredIds).toEqual(['zeta/deep-1', 'acme/swift-2']);
    expect(catalogue.models[2]?.reasoningEfforts).toEqual(['medium']);
  });

  it('drops unreadable entries, and throws when nothing is readable', () => {
    const parsed = parseCatalogue({
      object: 'list',
      data: [{ id: 'x/y' }, { id: 'p:x', object: 'routing_profile', name: 'Old' }, PAYLOAD.data[0]],
    });
    expect(parsed.models.map((m) => m.id)).toEqual(['acme/swift-2']);
    expect(parsed.defaultModelId).toBeNull();
    expect(() => parseCatalogue({ object: 'list' })).toThrow();
    expect(() => parseCatalogue({ object: 'list', data: [{ id: 'x/y' }] })).toThrow();
  });
});

describe('searchModels', () => {
  it('prefers an exact id, then an exact name', () => {
    expect(searchModels('acme/swift-2', catalogue).map((m) => m.id)).toEqual(['acme/swift-2']);
    expect(searchModels('swift 2', catalogue).map((m) => m.id)).toEqual(['acme/swift-2']);
  });

  it('matches every word across id, name and publisher', () => {
    expect(searchModels('beta', catalogue).map((m) => m.id)).toEqual(['beta/coder']);
    expect(searchModels('acme mini', catalogue).map((m) => m.id)).toEqual(['acme/swift-2-mini']);
    expect(searchModels('swift', catalogue)).toHaveLength(2);
    expect(searchModels('nothing', catalogue)).toEqual([]);
  });
});

describe('resolveSelection', () => {
  it('omits the model when nothing is chosen', () => {
    expect(resolveSelection('', catalogue)).toBeUndefined();
    expect(resolveSelection('', undefined)).toBeUndefined();
  });

  it('sends a listed id, or the one model some text matches', () => {
    expect(resolveSelection('beta/coder', catalogue)).toBe('beta/coder');
    expect(resolveSelection('deep', catalogue)).toBe('zeta/deep-1');
  });

  it('omits a withdrawn id, an ambiguous text, or a legacy identifier', () => {
    expect(resolveSelection('gone/model', catalogue)).toBeUndefined();
    expect(resolveSelection('swift', catalogue)).toBeUndefined();
    expect(resolveSelection('legacy-alias', catalogue)).toBeUndefined();
  });

  it('without a catalogue, sends only a publisher/model-shaped choice', () => {
    expect(resolveSelection('gone/model', undefined)).toBe('gone/model');
    expect(resolveSelection('swift', undefined)).toBeUndefined();
  });
});

describe('the /model listing', () => {
  it('puts featured first, then groups by publisher', () => {
    const groups = groupModels(catalogue);
    expect(groups.map((g) => g.title)).toEqual(['Featured', 'Acme', 'Beta Labs']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['zeta/deep-1', 'acme/swift-2']);
  });

  it('shows name, id and context, and marks the current and default models', () => {
    const text = formatModelList(catalogue, '');
    expect(text).toContain('Featured:');
    expect(text).toContain('  ● Swift 2 — Acme  acme/swift-2  (128K ctx, default)');
    expect(text).toContain('    Deep 1 — Zeta  zeta/deep-1  (1M ctx)');

    const chosen = formatModelList(catalogue, 'beta/coder');
    expect(chosen).toContain('  ● Coder — Beta Labs  beta/coder  (200K ctx)');
    expect(chosen).toContain('    Swift 2 — Acme');
  });

  it('labels the empty choice with the server default', () => {
    expect(labelForChoice('', catalogue)).toBe('Default (Swift 2)');
    expect(labelForChoice('', undefined)).toBe('Default model');
    expect(labelForChoice('beta/coder', catalogue)).toBe('Coder');
  });
});
