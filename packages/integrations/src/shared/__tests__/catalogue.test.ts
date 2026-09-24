import { describe, expect, it } from 'vitest';
import {
  currentModelLabel,
  defaultLabel,
  fitLines,
  modelsForListing,
  parseCatalogue,
  resolveModelCommand,
  resolveRequestModel,
  searchModels,
  storedChoice,
} from '../catalogue';

import { CATALOGUE } from './catalogue.fixture';

const catalogue = parseCatalogue(CATALOGUE);

describe('parseCatalogue', () => {
  it('reads the wire shape', () => {
    expect(catalogue.defaultModelId).toBe('acme/rocket-1');
    expect(catalogue.featuredIds).toEqual(['acme/rocket-1', 'globex/sage']);
    expect(catalogue.models.map((model) => model.id)).toEqual([
      'acme/rocket-1', 'acme/rocket-1-mini', 'globex/sage', 'initech/tps',
    ]);
    const first = catalogue.models[0];
    expect(first?.publisher).toEqual({ id: 'acme', name: 'Acme' });
    expect(first?.reasoningEfforts).toEqual(['low', 'high']);
    expect(first?.pricing).toEqual({ inputPerMTok: '3.00', outputPerMTok: '15.00' });
  });

  it('throws on a shape it cannot read, rather than reporting an empty catalogue', () => {
    expect(() => parseCatalogue(null)).toThrow();
    expect(() => parseCatalogue({ object: 'list' })).toThrow();
    expect(() => parseCatalogue({ object: 'list', data: [], featuredIds: [] })).toThrow();
    expect(() => parseCatalogue({ ...CATALOGUE, data: [{ id: 7 }] })).toThrow();
  });

  it('drops malformed entries, retired profile entries and duplicates', () => {
    const parsed = parseCatalogue({
      ...CATALOGUE,
      data: [
        CATALOGUE.data[0],
        CATALOGUE.data[0],
        { ...CATALOGUE.data[1], object: 'routing_profile' },
        { ...CATALOGUE.data[2], id: 'no-publisher' },
        { ...CATALOGUE.data[3], publisher: null },
      ],
    });
    expect(parsed.models.map((model) => model.id)).toEqual(['acme/rocket-1']);
  });

  it('accepts an empty catalogue', () => {
    expect(parseCatalogue({ ...CATALOGUE, data: [] }).models).toEqual([]);
  });
});

describe('storedChoice', () => {
  it('keeps a publisher/model id and reads every retired identifier as unset', () => {
    expect(storedChoice(' acme/rocket-1 ')).toBe('acme/rocket-1');
    for (const retired of [undefined, null, '', 'mode:' + 'auto', 'route:' + 'instant', 'profile:' + 'chat', 'alia-' + 'lite']) {
      expect(storedChoice(retired)).toBeNull();
    }
  });
});

describe('resolveRequestModel', () => {
  it('sends a chosen model the catalogue lists', () => {
    expect(resolveRequestModel('initech/tps', catalogue)).toBe('initech/tps');
  });

  it('omits model when unset, retired, or no longer listed', () => {
    expect(resolveRequestModel(undefined, catalogue)).toBeUndefined();
    expect(resolveRequestModel('route:' + 'auto', catalogue)).toBeUndefined();
    expect(resolveRequestModel('acme/withdrawn', catalogue)).toBeUndefined();
  });

  it('sends the chosen id as-is when the catalogue is unreadable', () => {
    expect(resolveRequestModel('acme/withdrawn', null)).toBe('acme/withdrawn');
    expect(resolveRequestModel(undefined, null)).toBeUndefined();
    expect(resolveRequestModel('mode:' + 'pro', null)).toBeUndefined();
  });
});

describe('listing and search', () => {
  it('lists featured first, in featuredIds order', () => {
    expect(modelsForListing(catalogue).map((model) => model.id)).toEqual([
      'acme/rocket-1', 'globex/sage', 'acme/rocket-1-mini', 'initech/tps',
    ]);
  });

  it('matches id, name and publisher case-insensitively, exact id first', () => {
    expect(searchModels(catalogue, 'ROCKET').map((model) => model.id)).toEqual([
      'acme/rocket-1', 'acme/rocket-1-mini',
    ]);
    expect(searchModels(catalogue, 'acme/rocket-1-mini').map((model) => model.id)).toEqual([
      'acme/rocket-1-mini',
    ]);
    expect(searchModels(catalogue, 'globex').map((model) => model.id)).toEqual(['globex/sage']);
    expect(searchModels(catalogue, '  ')).toEqual([]);
  });

  it('labels the current model, or the default', () => {
    expect(defaultLabel(catalogue)).toBe('Default (Rocket 1)');
    expect(currentModelLabel('globex/sage', catalogue)).toBe('Sage');
    expect(currentModelLabel(undefined, catalogue)).toBe('Default (Rocket 1)');
    expect(currentModelLabel('acme/withdrawn', catalogue)).toBe('Default (Rocket 1)');
  });
});

describe('resolveModelCommand', () => {
  it('lists with no argument and resets on default/reset', () => {
    expect(resolveModelCommand('', catalogue)).toEqual({ kind: 'list' });
    expect(resolveModelCommand(undefined, catalogue)).toEqual({ kind: 'list' });
    expect(resolveModelCommand('Default', catalogue)).toEqual({ kind: 'reset' });
    expect(resolveModelCommand('reset', catalogue)).toEqual({ kind: 'reset' });
  });

  it('selects an exact id even when other models also match', () => {
    const command = resolveModelCommand('ACME/rocket-1', catalogue);
    expect(command.kind === 'select' && command.model.id).toBe('acme/rocket-1');
  });

  it('selects a single match and lists several', () => {
    const one = resolveModelCommand('sage', catalogue);
    expect(one.kind === 'select' && one.model.id).toBe('globex/sage');
    const several = resolveModelCommand('acme', catalogue);
    expect(several.kind).toBe('matches');
    expect(resolveModelCommand('nothing-like-it', catalogue)).toEqual({ kind: 'none', query: 'nothing-like-it' });
  });
});

describe('fitLines', () => {
  it('keeps everything that fits, and counts what does not', () => {
    const lines = ['aaaa', 'bbbb', 'cccc', 'dddd'];
    expect(fitLines(lines, 100, (n) => `+${n}`)).toBe('aaaa\nbbbb\ncccc\ndddd');
    const fitted = fitLines(lines, 12, (n) => `+${n}`);
    expect(fitted).toBe('aaaa\nbbbb\n+2');
    expect(fitted.length).toBeLessThanOrEqual(12);
  });
});
