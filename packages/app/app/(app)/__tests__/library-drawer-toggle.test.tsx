import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A way out of the Library at phone width, and a name for its "+".
 *
 * At 390×844 the Library page rendered a title, a "+", a search box and four
 * filter chips — and no hamburger, no back button, no bottom bar. The drawer
 * sidebar sat at x = -245px, the only route back to chat, and the only way to
 * reach it was a swipe nobody is told about (#532). The fix is the one shared
 * `DrawerToggle` rendered FIRST in the header row; what is pinned here is that
 * it is there, that it comes before the title, that it is the drawer it opens,
 * and that it is named — because an unlabelled icon button is a second, quieter
 * version of the same fault.
 *
 * The "+" beside it had no accessible name either (#536), so that is pinned in
 * the same file: it is the same header, and the same class of mistake.
 *
 * `DrawerToggle` itself is rendered for real. It is the subject, and a stub of
 * it would let this test pass with the page rendering a button that opens
 * nothing.
 */

const toggleDrawer = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useNavigation: () => ({ toggleDrawer }),
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
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
    RefreshControl: host('RefreshControl'),
  };
});

/**
 * A list that renders what it is given, in order: the header, then the rows.
 *
 * The real one measures a native viewport this runner does not have, and what
 * is under test is the header it is handed, not how it recycles rows.
 */
vi.mock('@shopify/flash-list', async () => {
  const ReactModule = await import('react');
  return {
    FlashList: ({
      ListHeaderComponent,
      ListEmptyComponent,
      data,
      renderItem,
    }: {
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      data: unknown[];
      renderItem: (info: { item: unknown }) => React.ReactNode;
    }) =>
      ReactModule.createElement(
        'FlashList',
        null,
        ListHeaderComponent,
        data.length === 0 ? ListEmptyComponent : data.map((item) => renderItem({ item })),
      ),
  };
});

vi.mock('@oxy.so/bloom/search', async () => {
  const ReactModule = await import('react');
  return { Search: (props: Record<string, unknown>) => ReactModule.createElement('Search', props) };
});
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
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
vi.mock('@/components/ui/skeleton', async () => {
  const ReactModule = await import('react');
  return { Skeleton: (props: Record<string, unknown>) => ReactModule.createElement('Skeleton', props) };
});
vi.mock('@/components/ui/icons/menu-icon', async () => {
  const ReactModule = await import('react');
  return { MenuIcon: (props: Record<string, unknown>) => ReactModule.createElement('MenuIcon', props) };
});
vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Root: host('MenuRoot'),
    Trigger: host('MenuTrigger'),
    Content: host('MenuContent'),
    Item: host('MenuItem'),
    ItemIcon: host('MenuItemIcon'),
    ItemTitle: host('MenuItemTitle'),
  };
});
vi.mock('@/components/file-card', async () => {
  const ReactModule = await import('react');
  return { FileCard: (props: Record<string, unknown>) => ReactModule.createElement('FileCard', props) };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return { Plus: (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props) };
});
vi.mock('@/lib/hooks/use-image-picker', () => ({ useImagePicker: () => ({ pickImage: vi.fn() }) }));
vi.mock('@/lib/hooks/use-document-picker', () => ({
  useDocumentPicker: () => ({ pickDocument: vi.fn() }),
}));
vi.mock('@/lib/stores/library-store', () => {
  // One state object, so a selector reading `files` returns the same array on
  // every render rather than a fresh dependency each time.
  const state = {
    files: [] as unknown[],
    loading: false,
    loadFiles: vi.fn(async () => undefined),
    addFile: vi.fn(),
    deleteFile: vi.fn(),
  };
  return { useLibraryStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));
// `cn` (via `lib/utils.ts`) reaches `expo-crypto` through `random-uuid`, whose
// native module does not exist under this runner.
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));
/**
 * `t` returns its key, so an assertion names the KEY the screen reads and not
 * one language's rendering of it — the label is checked to exist in both
 * locale files separately below.
 */
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * A host element by its mocked name. Compared through a `string`, because
 * `node.type` is `ElementType` and a literal beside it is a type error.
 */
function isHost(node: ReactTestInstance, name: string): boolean {
  return node.type === name;
}

const { default: LibraryScreen } = await import('../library');

let renderer: ReactTestRenderer | null = null;

async function renderLibrary(): Promise<ReactTestRenderer> {
  let next!: ReactTestRenderer;
  await act(async () => {
    next = create(React.createElement(LibraryScreen));
  });
  renderer = next;
  return next;
}

/** Host `Button` nodes carrying the given accessibility label. */
function buttonsLabelled(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    (node) => isHost(node, 'Button') && node.props.accessibilityLabel === label,
  );
}

beforeEach(() => {
  toggleDrawer.mockClear();
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the Library header at phone width', () => {
  it('renders one labelled drawer toggle, hidden from md up', async () => {
    const { root } = await renderLibrary();

    const toggles = buttonsLabelled(root, 'nav.openNavigation');
    expect(toggles, 'exactly one way to open the drawer').toHaveLength(1);
    const [toggle] = toggles;
    expect(toggle.props.accessibilityRole).toBe('button');
    // Present below `md` only: at desktop widths the drawer is permanent and the
    // sidebar carries its own collapse control.
    expect(String(toggle.props.className)).toContain('md:hidden');
  });

  it('opens the drawer — the real one, through the navigator', async () => {
    const { root } = await renderLibrary();

    const [toggle] = buttonsLabelled(root, 'nav.openNavigation');
    await act(async () => {
      (toggle.props.onPress as () => void)();
    });
    expect(toggleDrawer).toHaveBeenCalledTimes(1);
  });

  it('puts the toggle before the title, in the same row', async () => {
    const { root } = await renderLibrary();

    // `findAll` walks the tree in document order, so relative position in the
    // result IS relative position on screen.
    const ordered = root.findAll(
      (node) =>
        (isHost(node, 'Button') && node.props.accessibilityLabel === 'nav.openNavigation') ||
        (isHost(node, 'Text') && node.props.children === 'library.title'),
    );
    expect(ordered.map((node) => node.type)).toEqual(['Button', 'Text']);

    // And in the same flex row: the toggle's nearest row ancestor contains the title.
    const [toggle] = buttonsLabelled(root, 'nav.openNavigation');
    let row: ReactTestInstance | null = toggle.parent;
    while (row !== null && !String(row.props.className ?? '').includes('flex-row')) {
      row = row.parent;
    }
    expect(row, 'the toggle sits in a flex row').not.toBeNull();
    expect(
      row?.findAll((node) => isHost(node, 'Text') && node.props.children === 'library.title'),
    ).toHaveLength(1);
  });

  it('names the "+" that opens the add-files menu (#536)', async () => {
    const { root } = await renderLibrary();

    const adders = buttonsLabelled(root, 'library.addFiles');
    expect(adders).toHaveLength(1);
    expect(adders[0].props.accessibilityRole).toBe('button');
    // It IS the menu trigger, not a second button beside it.
    const trigger = root.findAll((node) => isHost(node, 'MenuTrigger'));
    expect(trigger).toHaveLength(1);
    expect(trigger[0].findAll((node) => node === adders[0])).toHaveLength(1);
  });
});

/**
 * The labels exist in BOTH locales. `t` above returns its key, so a missing
 * translation would otherwise surface only as a raw key on screen, in one
 * language, for whoever happens to use it.
 */
describe('the labels are translated', () => {
  const locales = ['en', 'es'] as const;
  for (const locale of locales) {
    it(`${locale}: nav.openNavigation and library.addFiles`, () => {
      const messages = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../../lib/i18n/locales/${locale}.json`, import.meta.url)), 'utf8'),
      ) as { nav: Record<string, string>; library: Record<string, string> };
      expect(messages.nav.openNavigation).toMatch(/\S/);
      expect(messages.library.addFiles).toMatch(/\S/);
    });
  }
});

/**
 * The other top-level pages carry the same control in the same place, and the
 * drawer hides the sidebar from assistive tech while closed. Read off the
 * source: rendering four more screens and the drawer navigator here would be
 * four more mock sets for a claim that is one line per file.
 */
describe('the same opener on every top-level page', () => {
  const page = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../${name}.tsx`, import.meta.url)), 'utf8');

  for (const name of ['agents', 'skills', 'shows']) {
    it(`${name}.tsx renders DrawerToggle first in its header row`, () => {
      const source = page(name);
      expect(source).toMatch(/from ["']@\/components\/ui\/drawer-toggle["']/);
      // The toggle is rendered, and it precedes the page's title in the file.
      const toggleAt = source.indexOf('<DrawerToggle />');
      const titleAt = source.indexOf('text-2xl font-bold');
      expect(toggleAt, `${name}.tsx renders <DrawerToggle />`).toBeGreaterThan(-1);
      expect(toggleAt, 'and before the title').toBeLessThan(titleAt);
    });
  }

  it('notifications.tsx already has its own way out (a back control)', () => {
    expect(page('notifications')).toContain('router.back()');
  });

  it('the closed drawer takes the sidebar out of the accessibility tree', () => {
    const layout = page('_layout');
    expect(layout).toContain('useDrawerStatus');
    expect(layout).toContain("status === 'closed'");
    expect(layout).toContain('aria-hidden={hidden}');
    expect(layout).toContain("importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}");
    expect(layout).toContain('accessibilityElementsHidden={hidden}');
  });
});
