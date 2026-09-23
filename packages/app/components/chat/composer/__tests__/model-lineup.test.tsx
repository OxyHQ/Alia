import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The catalogue, translated into the two things Bloom's model menu takes.
 *
 * Bloom draws a flat radio list and reports the pressed row's **id**. That is
 * the identity contract `docs/chat-runtime.mdx` requires, so the id half needs
 * only to be carried across. What needed re-expressing is everything Alia's
 * own picker did BESIDES naming a model, and each of those is a test here:
 *
 *  - a row the plan does not cover raises the upgrade path and does NOT become
 *    the selection — the old `selectEntry` returned early, and here the same
 *    refusal is an intercepted `onModelChange` over a controlled value;
 *  - a gated row still says so before it is pressed, because a control whose
 *    refusal is only discoverable by pressing it reads as broken;
 *  - effort is the levels the CHOSEN entry can honour and an index into those,
 *    with `null` for "no level chosen, the model decides" — the common answer
 *    in this catalogue, and the one thing that must never look like a choice.
 *
 * `resolveSelection` and `effortFor` are the REAL ones. They are the two pure
 * functions this file's answers are built out of, and stubbing either would
 * leave the translation checked against a re-implementation of the thing it is
 * translating.
 */

const router = vi.hoisted(() => ({ push: vi.fn() }));
const toasted = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const store = vi.hoisted(() => ({ reasoningEffort: null as string | null, setReasoningEffort: vi.fn() }));
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
vi.mock('../provider-marks', () => ({ AliaMark: () => null, ModelsMark: () => null, DeviceMark: () => null }));
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

/**
 * Product modes, flattened to identity.
 *
 * `presentation` decides which words a row is drawn with and is pinned by
 * `lib/hooks/__tests__/use-product-modes.test.ts`; what is under test here is
 * which IDENTIFIER a row carries, so the label is passed through unchanged and
 * no profile is fronted by a mode.
 */
vi.mock('@/lib/hooks/use-product-modes', () => ({
  useProductModes: () => ({ data: [] }),
  modeById: (id: string) => (id === 'mode:auto' ? { id, label: 'Automatic', routing: { profileId: 'profile:auto' } } : null),
  modeForProfile: () => null,
  presentation: (entry: { displayName: string }) => ({ label: entry.displayName }),
}));

vi.mock('@/lib/hooks/use-local-runtimes', () => ({
  useLocalModelOptions: () => ({
    options: [{ id: 'local:llama', name: 'Llama', deviceLabel: 'Desk' }],
    ids: ['local:llama'],
  }),
}));

vi.mock('@/lib/stores/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stores/model-store')>();
  return {
    ...actual,
    useModelStore: (select: (state: typeof store) => unknown) => select(store),
  };
});

import { useComposerLineup } from '../model-lineup';
import type { CatalogueEntry } from '@/lib/hooks/use-catalogue';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  router.push.mockClear();
  toasted.info.mockClear();
  store.setReasoningEffort.mockClear();
  store.reasoningEffort = null;
  catalogue.data = undefined;
});

function entry(over: Partial<CatalogueEntry> & { id: string }): CatalogueEntry {
  return {
    kind: 'model',
    publisher: null,
    model: null,
    displayName: over.id,
    description: '',
    emoji: null,
    category: 'general',
    chatVisible: true,
    unavailable: false,
    requiredPlan: null,
    entitled: true,
    creditMultiplier: null,
    sunsetAt: null,
    provenance: { publishers: [], unattributedRoutes: 0 },
    capabilities: {
      tools: 'unknown',
      vision: 'unknown',
      audio: 'unknown',
      reasoning: 'unknown',
      reasoningLevels: [],
      structuredOutput: 'unknown',
      contextWindow: null,
      maxOutput: null,
    },
    ...over,
  } as CatalogueEntry;
}

function run(selected: string, onModelChange = vi.fn()) {
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
  it('leads with the automatic choice and ends with this account’s own machines', () => {
    catalogue.data = [entry({ id: 'model:fast', displayName: 'Fast' })];
    const { lineup } = run('mode:auto');
    expect(lineup.models.map((m) => m.id)).toEqual(['mode:auto', 'model:fast', 'local:llama']);
    // A device model names its device: a phone can be offered a model running
    // on a laptop, and "which one" is the whole question then.
    expect(lineup.models[2].name).toBe('Llama · Desk');
  });

  it('groups the rail by Alia\'s own sections, never by an operator', () => {
    catalogue.data = [entry({ id: 'model:fast', displayName: 'Fast' })];
    const { lineup } = run('mode:auto');
    expect(lineup.providers.map((p) => [p.id, p.models.map((m) => m.id)])).toEqual([
      ['alia', ['mode:auto']],
      ['models', ['model:fast']],
      ['device', ['local:llama']],
    ]);
  });

  it('drops what the catalogue says it cannot serve', () => {
    catalogue.data = [
      entry({ id: 'model:fast', displayName: 'Fast' }),
      entry({ id: 'model:down', displayName: 'Down', unavailable: true }),
      entry({ id: 'model:hidden', displayName: 'Hidden', chatVisible: false }),
    ];
    const { lineup } = run('mode:auto');
    expect(lineup.models.map((m) => m.id)).toEqual(['mode:auto', 'model:fast', 'local:llama']);
  });

  it('draws a name and reports an id, which are not the same string', () => {
    catalogue.data = [entry({ id: 'model:fast', displayName: 'Fast' })];
    const { lineup, onModelChange } = run('mode:auto');
    const row = lineup.models.find((m) => m.id === 'model:fast');
    expect(row?.name).toBe('Fast');
    lineup.onModelChange('model:fast');
    expect(onModelChange).toHaveBeenCalledWith('model:fast');
  });
});

describe('the plan gate, which survives as a refusal rather than a row', () => {
  it('says a row is locked before anybody presses it', () => {
    catalogue.data = [entry({ id: 'model:pro', displayName: 'Pro', entitled: false, requiredPlan: 'Max' })];
    const { lineup } = run('mode:auto');
    expect(lineup.models.find((m) => m.id === 'model:pro')?.name).toBe('🔒 Pro');
  });

  it('offers the upgrade and leaves the selection alone', () => {
    catalogue.data = [entry({ id: 'model:pro', displayName: 'Pro', entitled: false, requiredPlan: 'Max' })];
    const { lineup, onModelChange } = run('mode:auto');
    lineup.onModelChange('model:pro');
    expect(toasted.info).toHaveBeenCalledWith('subscribe.modelRequiresPlan {"plan":"Max"}');
    expect(router.push).toHaveBeenCalledWith('/(biglayout)/subscribe');
    // The point of the whole interception: the chip keeps naming the model
    // that is actually in force.
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('says "upgrade" rather than naming a plan it was not told', () => {
    catalogue.data = [entry({ id: 'model:pro', displayName: 'Pro', entitled: false, requiredPlan: null })];
    const { lineup } = run('mode:auto');
    lineup.onModelChange('model:pro');
    expect(toasted.info).toHaveBeenCalledWith('subscribe.modelRequiresUpgrade');
  });

  it('never gates a model on the person’s own machine', () => {
    catalogue.data = [];
    const { lineup, onModelChange } = run('mode:auto');
    lineup.onModelChange('local:llama');
    expect(onModelChange).toHaveBeenCalledWith('local:llama');
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('effort, as a second axis with its own answers', () => {
  it('drops the axis outright when the chosen entry offers no level', () => {
    // The common case: a routing profile fanning out over many deployments
    // offers a level only if all of them can send it. `[]` is what tells
    // Bloom to draw no slider — the old control drew one whose `max` was 0.
    catalogue.data = [entry({ id: 'model:fast', displayName: 'Fast' })];
    const { lineup } = run('model:fast');
    expect(lineup.effortLevels).toEqual([]);
    expect(lineup.effort).toBeNull();
  });

  it('offers only the levels the chosen entry can honour', () => {
    catalogue.data = [
      entry({
        id: 'model:thinks',
        displayName: 'Thinks',
        capabilities: { ...entry({ id: 'x' }).capabilities, reasoningLevels: ['instant', 'high'] },
      }),
    ];
    const { lineup } = run('model:thinks');
    // Two stops, not four: there is no position on this track that the model
    // cannot serve, which is what the old slider enforced by snapping.
    expect(lineup.effortLevels).toEqual(['effort.levels.instant', 'effort.levels.high']);
  });

  it('indexes into the OFFERED levels, not into the catalogue’s four', () => {
    store.reasoningEffort = 'high';
    catalogue.data = [
      entry({
        id: 'model:thinks',
        displayName: 'Thinks',
        capabilities: { ...entry({ id: 'x' }).capabilities, reasoningLevels: ['instant', 'high'] },
      }),
    ];
    const { lineup } = run('model:thinks');
    // `high` is the fourth of `EFFORT_LEVELS` and the SECOND thing on offer.
    expect(lineup.effort).toBe(1);
  });

  it('reads a stored level the chosen entry cannot honour as no level at all', () => {
    store.reasoningEffort = 'max';
    catalogue.data = [
      entry({
        id: 'model:thinks',
        displayName: 'Thinks',
        capabilities: { ...entry({ id: 'x' }).capabilities, reasoningLevels: ['instant', 'high'] },
      }),
    ];
    const { lineup } = run('model:thinks');
    // Not clamped to the nearest, and not sent: a level the entry does not
    // offer is the parameter being omitted, and `null` is how the control
    // says so rather than showing a stop nobody chose.
    expect(lineup.effort).toBeNull();
  });

  it('writes back the level at the index Bloom reports', () => {
    catalogue.data = [
      entry({
        id: 'model:thinks',
        displayName: 'Thinks',
        capabilities: { ...entry({ id: 'x' }).capabilities, reasoningLevels: ['instant', 'high'] },
      }),
    ];
    const { lineup } = run('model:thinks');
    lineup.onEffortChange(1);
    expect(store.setReasoningEffort).toHaveBeenCalledWith('high');
  });

  it('reads an index the lineup no longer has as no level, never as a guess', () => {
    catalogue.data = [
      entry({
        id: 'model:thinks',
        displayName: 'Thinks',
        capabilities: { ...entry({ id: 'x' }).capabilities, reasoningLevels: ['instant'] },
      }),
    ];
    const { lineup } = run('model:thinks');
    lineup.onEffortChange(3);
    expect(store.setReasoningEffort).toHaveBeenCalledWith(null);
  });
});
