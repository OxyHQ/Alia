import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the Skills catalogue mounts is bounded (#545).
 *
 * The page froze Chrome because it mounted every book in every shelf, twice
 * for installed ones, and every book was an animated canvas. The cover's side
 * of that is pinned in `skill-cover-static.test.tsx`; this file pins the
 * SCREEN's side: with a hundred catalogue records and ten of them installed,
 *
 * - an installed skill is on the Installed shelf and in no catalogue row, so
 *   the data the shelves are handed carries each id once;
 * - only a viewport's worth of books mounts per shelf, because each shelf is
 *   a horizontal FlashList with a `drawDistance`;
 * - no Skia canvas exists anywhere in the tree, and the skia package is never
 *   imported;
 * - a keystroke waits 250 ms before it becomes a request; and
 * - a failed load says so and offers a retry.
 *
 * FlashList itself measures a native viewport this runner does not have, so
 * the mock below models one: a 390 px viewport that mounts what fits in it
 * plus the `drawDistance` the shelf asked for, at the shelf's book stride. The
 * bound asserted is therefore "the screen hands its lists a window and mounts
 * nothing outside it", which is exactly the property the freeze lacked.
 */

const VIEWPORT_WIDTH = 390;
/** A book is 110 wide with a 10 gap; see `skills.tsx`. */
const BOOK_STRIDE = 120;

const reached = vi.hoisted(() => ({ skia: 0 }));
vi.mock('@shopify/react-native-skia', () => {
  reached.skia += 1;
  throw new Error('@shopify/react-native-skia was imported by the catalogue');
});
vi.mock('@shopify/react-native-skia/lib/module/web', () => {
  reached.skia += 1;
  throw new Error('LoadSkiaWeb was imported by the catalogue');
});
vi.mock('react-native-reanimated', () => {
  throw new Error('react-native-reanimated was imported by the catalogue');
});

const hooks = vi.hoisted(() => ({
  catalogue: vi.fn(),
  installed: vi.fn(),
  install: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/hooks/use-skills', () => ({
  useSkillCataloguePages: hooks.catalogue,
  useInstalledSkills: hooks.installed,
  useInstallSkill: () => hooks.install,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    StyleSheet: { absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
    View: host('View'),
    Text: host('Text'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
    RefreshControl: host('RefreshControl'),
  };
});
vi.mock('@shopify/flash-list', async () => {
  const ReactModule = await import('react');
  return {
    FlashList: <TItem,>({
      data,
      renderItem,
      keyExtractor,
      drawDistance = 250,
      ...rest
    }: {
      data: TItem[];
      renderItem: (info: { item: TItem; index: number }) => React.ReactNode;
      keyExtractor: (item: TItem, index: number) => string;
      drawDistance?: number;
      horizontal?: boolean;
      onEndReached?: () => void;
    } & Record<string, unknown>) => {
      const window = Math.ceil((VIEWPORT_WIDTH + drawDistance) / BOOK_STRIDE);
      // Everything else (`horizontal`, `onEndReached`, …) lands on the host
      // node so a test can read what the shelf asked its list for.
      return ReactModule.createElement(
        'FlashList',
        { ...rest, data, drawDistance },
        data.slice(0, window).map((item, index) =>
          ReactModule.createElement(ReactModule.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })),
        ),
      );
    },
  };
});
vi.mock('expo-linear-gradient', async () => {
  const ReactModule = await import('react');
  return {
    LinearGradient: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('LinearGradient', props, children),
  };
});
vi.mock('@oxy.so/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});
vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@/components/ui/input', async () => {
  const ReactModule = await import('react');
  return { Input: (props: Record<string, unknown>) => ReactModule.createElement('Input', props) };
});
vi.mock('@/components/ui/skeleton', async () => {
  const ReactModule = await import('react');
  return { Skeleton: (props: Record<string, unknown>) => ReactModule.createElement('Skeleton', props) };
});
vi.mock('@/components/ui/drawer-toggle', async () => {
  const ReactModule = await import('react');
  return { DrawerToggle: (props: Record<string, unknown>) => ReactModule.createElement('DrawerToggle', props) };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  return { Check: glyph, Download: glyph, Plus: glyph, Search: glyph };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ isDarkColorScheme: false, colors: {} }),
}));
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { default: SkillsScreen } = await import('../skills');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function skill(index: number, source: 'builtin' | 'github') {
  return {
    _id: `id-${index}`,
    name: `skill-${index}`,
    displayName: `Skill ${index}`,
    description: index % 10 === 0 ? 'A tenth skill' : `Does thing ${index}`,
    license: null,
    compatibility: null,
    allowedTools: [],
    specMetadata: {},
    source,
    sourceRepo: null,
    sourcePath: null,
    sourceUrl: null,
    publisher: 'someone',
    tags: [],
    icon: null,
    color: null,
    ownerOxyUserId: null,
    visibility: 'public' as const,
    installCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** A hundred records: fifty official, fifty community. */
const CATALOGUE = Array.from({ length: 100 }, (_, i) => skill(i, i < 50 ? 'builtin' : 'github'));
/** Ten of them installed — five from each half — so a naive screen shows them twice. */
const INSTALLED = [0, 1, 2, 3, 4, 50, 51, 52, 53, 54].map((i) => ({
  ...CATALOGUE[i]!,
  enabled: true,
  autoInvoke: true,
  pinnedVersion: null,
  installedVersion: 1,
}));
const INSTALLED_IDS = new Set(INSTALLED.map((entry) => entry._id));

function catalogueResult(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [CATALOGUE], pageParams: [0] },
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let renderer: ReactTestRenderer | null = null;

/**
 * A host element by its mocked name. Compared through a `string`, because
 * `node.type` is `ElementType` and a literal beside it is a type error.
 */
function isHost(node: ReactTestInstance, name: string): boolean {
  return node.type === name;
}

function renderScreen(): ReactTestRenderer {
  let next!: ReactTestRenderer;
  act(() => {
    next = create(React.createElement(SkillsScreen));
  });
  renderer = next;
  return next;
}

function shelves(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => isHost(node, 'FlashList'));
}

function mountedCovers(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => isHost(node, 'View') && node.props.accessibilityRole === 'image');
}

function textsOf(root: ReactTestInstance): unknown[] {
  return root.findAll((node) => isHost(node, 'Text')).map((node) => node.props.children);
}

beforeEach(() => {
  hooks.catalogue.mockReset();
  hooks.installed.mockReset();
  hooks.catalogue.mockReturnValue(catalogueResult());
  hooks.installed.mockReturnValue({ data: INSTALLED, refetch: vi.fn() });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('the Skills catalogue with 100 records and 10 installed duplicates', () => {
  it('hands each installed skill to the Installed shelf only', () => {
    const { root } = renderScreen();
    const lists = shelves(root);
    expect(lists).toHaveLength(3);
    expect(lists.every((list) => list.props.horizontal === true)).toBe(true);

    const [installedShelf, official, community] = lists as [ReactTestInstance, ReactTestInstance, ReactTestInstance];
    const ids = (list: ReactTestInstance) => (list.props.data as { _id: string }[]).map((entry) => entry._id);

    expect(ids(installedShelf)).toEqual([...INSTALLED_IDS]);
    expect(ids(official).filter((id) => INSTALLED_IDS.has(id))).toEqual([]);
    expect(ids(community).filter((id) => INSTALLED_IDS.has(id))).toEqual([]);
    // Nothing was lost in the dedupe: 100 records, each on exactly one shelf.
    expect(ids(installedShelf).length + ids(official).length + ids(community).length).toBe(100);
  });

  it('mounts only a viewport window of covers per shelf, and no canvas', () => {
    const { root } = renderScreen();
    const lists = shelves(root);
    const perShelfBound = Math.ceil((VIEWPORT_WIDTH + (lists[0]!.props.drawDistance as number)) / BOOK_STRIDE);

    // Every shelf asked for a draw distance, so the list can window at all.
    expect(lists.every((list) => typeof list.props.drawDistance === 'number')).toBe(true);

    const covers = mountedCovers(root);
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.length).toBeLessThanOrEqual(lists.length * perShelfBound);
    expect(covers.length).toBeLessThan(110);

    // No book is on screen twice.
    const labels = covers.map((cover) => cover.props.accessibilityLabel as string);
    expect(new Set(labels).size).toBe(labels.length);

    expect(root.findAll((node) => typeof node.type === 'string' && /^(Canvas|Rect|Group|Shadow)$/.test(node.type))).toHaveLength(0);
    expect(root.findAll((node) => isHost(node, 'BlurView'))).toHaveLength(0);
    expect(reached.skia).toBe(0);
  });

  it('waits 250 ms after a keystroke before asking the catalogue', () => {
    vi.useFakeTimers();
    const { root } = renderScreen();
    const input = root.find((node) => isHost(node, 'Input'));

    act(() => {
      (input.props.onChangeText as (text: string) => void)('ten');
    });
    expect(hooks.catalogue.mock.lastCall?.[0]).toEqual({});

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(hooks.catalogue.mock.lastCall?.[0]).toEqual({});

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hooks.catalogue.mock.lastCall?.[0]).toEqual({ query: 'ten' });

    // The Installed shelf obeys the same search, so an installed skill that
    // matches is found on its own shelf rather than hidden by the dedupe.
    const installedShelf = shelves(root)[0]!;
    const installedIds = (installedShelf.props.data as { _id: string }[]).map((entry) => entry._id);
    expect(installedIds).toEqual(['id-0', 'id-50']);

    // Clearing answers at once — an empty box is not a search.
    act(() => {
      (input.props.onChangeText as (text: string) => void)('');
    });
    expect(hooks.catalogue.mock.lastCall?.[0]).toEqual({});
  });

  it('says a failed load failed, and retries on request', () => {
    const refetch = vi.fn();
    hooks.catalogue.mockReturnValue(catalogueResult({ data: undefined, isError: true, refetch }));
    hooks.installed.mockReturnValue({ data: [], refetch: vi.fn() });
    const { root } = renderScreen();

    expect(textsOf(root)).toContain('skills.loadFailed');
    // Not "no results": an error is not an empty catalogue.
    expect(textsOf(root)).not.toContain('skills.empty');

    const retry = root.find(
      (node) =>
        isHost(node, 'Button') &&
        node.findAll((child) => isHost(child, 'Text') && child.props.children === 'common.tryAgain').length > 0,
    );
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('offers the next page when there is one', () => {
    const fetchNextPage = vi.fn();
    hooks.catalogue.mockReturnValue(catalogueResult({ hasNextPage: true, fetchNextPage }));
    const { root } = renderScreen();

    const more = root.find(
      (node) =>
        isHost(node, 'Button') &&
        node.findAll((child) => isHost(child, 'Text') && child.props.children === 'skills.loadMore').length > 0,
    );
    act(() => {
      (more.props.onPress as () => void)();
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // Scrolling a catalogue shelf to its end asks for the same page.
    const official = shelves(root)[1]!;
    act(() => {
      (official.props.onEndReached as () => void)();
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});
