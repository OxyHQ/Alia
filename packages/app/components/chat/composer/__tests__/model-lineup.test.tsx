import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The catalogue, translated into what Bloom's model picker takes.
 *
 * Alia has no models of its own, so the lineup is the real models grouped by
 * publisher, after a first group of the server's featured models and the
 * person's pins, and before this account's devices. Effort is the CHOSEN
 * model's own `reasoningEfforts`, with `null` for "the model decides".
 *
 * `resolveSelection` and `effortFor` are the REAL ones.
 */

const router = vi.hoisted(() => ({ push: vi.fn() }));
const toasted = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const store = vi.hoisted(() => ({
  reasoningEffort: null as string | null,
  setReasoningEffort: vi.fn(),
  pinnedModels: [] as string[],
  togglePinnedModel: vi.fn(),
}));
const catalogue = vi.hoisted(() => ({ data: undefined as unknown }));

/**
 * This file renders no tree, and still needs react-native.
 *
 * The real `use-catalogue.ts` and `model-store.ts` are imported for their pure
 * functions, and the graph behind them reaches `react-native` — which ships
 * Flow and is parsed by Metro, not by this runner. Without the stub the suite
 * fails with `Flow is not supported`, pointing at the import rather than at
 * the package.
 */
vi.mock('../provider-marks', () => ({ FeaturedMark: () => null, DeviceMark: () => null, publisherMark: () => () => null }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toasted }));
/**
 * `t` returns the key, and the interpolations after it.
 *
 * Naming the key rather than one language's wording of it is the usual reason;
 * carrying the params is the specific one here, because the plan name in the
 * upgrade sentence is the only thing that makes it the RIGHT sentence.
 */
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  }),
}));

/**
 * The two things `use-catalogue.ts` reaches the network through.
 *
 * Both have to be stubbed BEFORE `importOriginal` below, because that import
 * runs the real module: `@oxy.so/services` re-exports from Bloom's raw source
 * through a wildcard subpath vitest does not inline, so without this the file
 * dies at `SyntaxError: Unexpected token 'typeof'` with a stack pointing at
 * the import that triggered it rather than at the package that could not be
 * parsed.
 */
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ oxyServices: null, isAuthenticated: false }) }));
vi.mock('@/lib/api/client', () => ({ default: { get: vi.fn() } }));

/**
 * Only the QUERY is replaced; the module's pure functions are the originals.
 */
vi.mock('@/lib/hooks/use-catalogue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-catalogue')>();
  return { ...actual, useCatalogue: () => catalogue };
});

vi.mock('@/lib/hooks/use-local-runtimes', () => ({
  useLocalModelOptions: () => ({
    options: [{ id: 'local/ollama/llama', name: 'Llama', deviceLabel: 'Desk' }],
    ids: ['local/ollama/llama'],
  }),
}));

vi.mock('@/lib/stores/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stores/model-store')>();
  return {
    ...actual,
    useModelStore: (select: (state: typeof store) => unknown) => select(store),
  };
});

import { modelIdOfRow, useComposerLineup } from '../model-lineup';
import type { Catalogue, CatalogueEntry } from '@/lib/hooks/use-catalogue';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  store.setReasoningEffort.mockClear();
  store.togglePinnedModel.mockClear();
  store.reasoningEffort = null;
  store.pinnedModels = [];
  catalogue.data = undefined;
});

function entry(over: Partial<CatalogueEntry> & { id: string }): CatalogueEntry {
  const publisher = over.id.split('/')[0]!;
  return {
    name: over.id,
    publisher: { id: publisher, name: publisher.toUpperCase() },
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
    ...over,
  };
}

function load(entries: CatalogueEntry[], extra: Partial<Catalogue> = {}) {
  catalogue.data = { entries, defaultModelId: entries[0]?.id ?? null, featuredIds: [], ...extra } satisfies Catalogue;
}

function run(selected: string | null, onModelChange = vi.fn()) {
  let lineup!: ReturnType<typeof useComposerLineup>;
  function Probe() {
    lineup = useComposerLineup(selected, onModelChange);
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  return { lineup, onModelChange };
}

describe('the lineup', () => {
  it('groups real models by publisher, alphabetically, newest release first', () => {
    load([
      entry({ id: 'zeta/one', name: 'Zeta One' }),
      entry({ id: 'acme/old', name: 'Old', releasedAt: '2025-01-01' }),
      entry({ id: 'acme/new', name: 'New', releasedAt: '2026-01-01' }),
    ]);
    const { lineup } = run(null);
    expect(lineup.providers.map((p) => p.name)).toEqual(['ACME', 'ZETA', 'composer.deviceGroup']);
    expect(lineup.providers[0]!.models.map((m) => m.name)).toEqual(['New', 'Old']);
    expect(lineup.providers[2]!.models).toEqual([{ id: 'local/ollama/llama', name: 'Llama · Desk' }]);
  });

  it('puts the featured models first, in the server order, then the pins', () => {
    store.pinnedModels = ['zeta/one', 'gone/model'];
    load([entry({ id: 'acme/a' }), entry({ id: 'acme/b' }), entry({ id: 'zeta/one' })], {
      featuredIds: ['acme/b', 'acme/a'],
    });
    const { lineup } = run(null);
    const first = lineup.providers[0]!;
    expect(first.name).toBe('composer.featuredGroup');
    expect(first.models.map((m) => modelIdOfRow(m.id))).toEqual(['acme/b', 'acme/a', 'zeta/one']);
    // Still in their publisher's group too, under a different row id.
    expect(lineup.providers[1]!.models.map((m) => m.id)).toEqual(['acme/a', 'acme/b']);
    expect(new Set(lineup.providers.flatMap((p) => p.models.map((m) => m.id))).size).toBe(7);
  });

  it('shows the server default while nothing is chosen, and reports a real id when a row is pressed', () => {
    load([entry({ id: 'acme/a' }), entry({ id: 'acme/b' })], { defaultModelId: 'acme/b', featuredIds: ['acme/b'] });
    const { lineup, onModelChange } = run(null);
    expect(modelIdOfRow(lineup.model)).toBe('acme/b');
    lineup.onModelChange(lineup.providers[0]!.models[0]!.id);
    expect(onModelChange).toHaveBeenCalledWith('acme/b');
  });

  it('falls back to the default for a model the catalogue no longer lists', () => {
    load([entry({ id: 'acme/a' })]);
    expect(run('gone/model').lineup.model).toBe('acme/a');
  });

  it('keeps a model on a connected device', () => {
    load([entry({ id: 'acme/a' })]);
    expect(run('local/ollama/llama').lineup.model).toBe('local/ollama/llama');
  });
});

describe('effort', () => {
  it('offers the chosen model its own levels, and none for a model without', () => {
    load([entry({ id: 'acme/think', reasoningEfforts: ['low', 'medium', 'high'] }), entry({ id: 'acme/plain' })]);
    expect(run('acme/think').lineup.effortLevels).toEqual([
      'effort.levels.low',
      'effort.levels.medium',
      'effort.levels.high',
    ]);
    act(() => renderer?.unmount());
    expect(run('acme/plain').lineup.effortLevels).toEqual([]);
  });

  it('is null — the model decides — until a level is chosen, and a stored level the model lacks is null too', () => {
    load([entry({ id: 'acme/think', reasoningEfforts: ['low', 'high'] })]);
    expect(run('acme/think').lineup.effort).toBeNull();
    act(() => renderer?.unmount());
    store.reasoningEffort = 'medium';
    expect(run('acme/think').lineup.effort).toBeNull();
    act(() => renderer?.unmount());
    store.reasoningEffort = 'high';
    const { lineup } = run('acme/think');
    expect(lineup.effort).toBe(1);
    lineup.onEffortChange(0);
    expect(store.setReasoningEffort).toHaveBeenCalledWith('low');
  });
});

describe('pins', () => {
  it('names the chosen model for the add menu and toggles its pin', () => {
    store.pinnedModels = ['acme/a'];
    load([entry({ id: 'acme/a', name: 'A' })]);
    const { lineup } = run('acme/a');
    expect(lineup.current).toEqual({ id: 'acme/a', name: 'A', pinned: true });
    lineup.togglePinned();
    expect(store.togglePinnedModel).toHaveBeenCalledWith('acme/a');
  });
});
