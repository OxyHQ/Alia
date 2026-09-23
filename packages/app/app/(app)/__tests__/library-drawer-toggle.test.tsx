import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
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

const navToggle = vi.hoisted(() => vi.fn());

/**
 * What `AiChatShell` publishes, as this file hands it out.
 *
 * The shell itself is mocked and the guard is NOT: `useAiChatShell` is the
 * source of the signal, and stubbing a signal to see what something does with
 * it is the only way to see both of its branches. Mounting a real `AiChatShell`
 * here would also drag reanimated, svg and the whole `ai-chat` barrel through a
 * `react-native` mock that exports four components.
 */
const shell = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock('@oxy.so/bloom/ai-chat', () => ({
  useAiChatShell: () => shell.current,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Platform: {
      OS: 'web',
      select: (spec: Record<string, unknown>) => spec.web,
    },
    // `ShellNavProvider`'s fallback reads the window when there is no shell.
    useWindowDimensions: () => ({
      width: 1280,
      height: 800,
      scale: 1,
      fontScale: 1,
    }),
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
        data.length === 0
          ? ListEmptyComponent
          : data.map((item) => renderItem({ item })),
      ),
  };
});

vi.mock('@oxy.so/bloom/search', async () => {
  const ReactModule = await import('react');
  return {
    Search: (props: Record<string, unknown>) =>
      ReactModule.createElement('Search', props),
  };
});
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock('@oxy.so/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@oxy.so/bloom/skeleton', async () => {
  const ReactModule = await import('react');
  const shape = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);
  return {
    Box: shape('Skeleton'),
    Circle: shape('Skeleton'),
    Pill: shape('Skeleton'),
    Text: shape('Skeleton'),
  };
});
vi.mock('@/components/ui/icons/menu-icon', async () => {
  const ReactModule = await import('react');
  return {
    MenuIcon: (props: Record<string, unknown>) =>
      ReactModule.createElement('MenuIcon', props),
  };
});
vi.mock('@oxy.so/bloom/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    DropdownMenu: host('MenuRoot'),
    DropdownMenuTrigger: host('MenuTrigger'),
    DropdownMenuContent: host('MenuContent'),
    DropdownMenuItem: host('MenuItem'),
  };
});
vi.mock('@/components/file-card', async () => {
  const ReactModule = await import('react');
  return {
    FileCard: (props: Record<string, unknown>) =>
      ReactModule.createElement('FileCard', props),
  };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return {
    Plus: (props: Record<string, unknown>) =>
      ReactModule.createElement('Glyph', props),
  };
});
vi.mock('@/lib/hooks/use-image-picker', () => ({
  useImagePicker: () => ({ pickImage: vi.fn() }),
}));
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
  return {
    useLibraryStore: (select: (s: typeof state) => unknown) => select(state),
  };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));
// `cn` (via `lib/utils.ts`) reaches `expo-crypto` through `random-uuid`, whose
// native module does not exist under this runner.
vi.mock('expo-crypto', () => ({
  getRandomValues: (array: Uint8Array) => array,
}));
/**
 * `t` returns its key, so an assertion names the KEY the screen reads and not
 * one language's rendering of it — the label is checked to exist in both
 * locale files separately below.
 */
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return {
    useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }),
  };
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
const { AppNavProvider } = await import('@/components/app-shell/nav-context');
const { NavRegion } = await import('@/components/app-shell/nav-region');
type AppNav = import('@/components/app-shell/nav-context').AppNav;

/** The nav the Library page is rendered inside: a closed drawer on a phone. */
const NAV: AppNav = {
  inFlow: false,
  presented: false,
  open: () => undefined,
  close: () => undefined,
  toggle: navToggle,
};

/** A shell state with the one field under test set, and the rest plausible. */
function shellWith(navPresented: boolean): Record<string, unknown> {
  return {
    compact: true,
    navCollapsed: true,
    hasNav: true,
    hasPanel: false,
    navPresented,
    sidebarCollapsed: false,
    openNav: () => undefined,
    closeNav: () => undefined,
    openPanel: () => undefined,
    panelLabel: 'Code',
    panelIcon: null,
    labels: { openNavigation: 'Open navigation', openPanel: () => '' },
  };
}

/** Mounts a node and hands back its renderer, unmounted by the caller. */
function mount(node: React.ReactElement): ReactTestRenderer {
  let next!: ReactTestRenderer;
  act(() => {
    next = create(node);
  });
  return next;
}

let renderer: ReactTestRenderer | null = null;

async function renderLibrary(): Promise<ReactTestRenderer> {
  let next!: ReactTestRenderer;
  await act(async () => {
    next = create(
      React.createElement(
        AppNavProvider,
        { value: NAV },
        React.createElement(LibraryScreen),
      ),
    );
  });
  renderer = next;
  return next;
}

/** Host `Button` nodes carrying the given accessibility label. */
function buttonsLabelled(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance[] {
  return root.findAll(
    (node) => isHost(node, 'Button') && node.props.accessibilityLabel === label,
  );
}

beforeEach(() => {
  navToggle.mockClear();
  shell.current = null;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the Library header at phone width', () => {
  it('renders one labelled drawer toggle, hidden from lg up', async () => {
    const { root } = await renderLibrary();

    const toggles = buttonsLabelled(root, 'nav.openNavigation');
    expect(toggles, 'exactly one way to open the drawer').toHaveLength(1);
    const [toggle] = toggles;
    expect(toggle.props.accessibilityRole).toBe('button');
    /*
     * `lg:hidden`, and the number matters more than the utility does.
     *
     * It was `md:hidden` for as long as the drawer was expo-router's, because
     * that drawer became `permanent` at 768. `AiChatShell` holds the nav in
     * flow only from 1024, so between 768 and 1023 there IS a drawer — and an
     * opener hidden at 768 would leave that whole band with nothing that opens
     * it, which is #532 at a width the visual baseline photographs. A
     * regression to `md:hidden` is the exact fault this line exists to catch,
     * so it is asserted as an absence as well as a presence.
     */
    expect(String(toggle.props.className)).toContain('lg:hidden');
    expect(String(toggle.props.className)).not.toContain('md:hidden');
  });

  it("opens the drawer — the real one, through the shell's own nav", async () => {
    const { root } = await renderLibrary();

    const [toggle] = buttonsLabelled(root, 'nav.openNavigation');
    await act(async () => {
      (toggle.props.onPress as () => void)();
    });
    expect(navToggle).toHaveBeenCalledTimes(1);
  });

  it('puts the toggle before the title, in the same row', async () => {
    const { root } = await renderLibrary();

    // `findAll` walks the tree in document order, so relative position in the
    // result IS relative position on screen.
    const ordered = root.findAll(
      (node) =>
        (isHost(node, 'Button') &&
          node.props.accessibilityLabel === 'nav.openNavigation') ||
        (isHost(node, 'Text') && node.props.children === 'library.title'),
    );
    expect(ordered.map((node) => node.type)).toEqual(['Button', 'Text']);

    // And in the same flex row: the toggle's nearest row ancestor contains the title.
    const [toggle] = buttonsLabelled(root, 'nav.openNavigation');
    let row: ReactTestInstance | null = toggle.parent;
    while (
      row !== null &&
      !String(row.props.className ?? '').includes('flex-row')
    ) {
      row = row.parent;
    }
    expect(row, 'the toggle sits in a flex row').not.toBeNull();
    expect(
      row?.findAll(
        (node) =>
          isHost(node, 'Text') && node.props.children === 'library.title',
      ),
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
    it(`${locale}: nav.openNavigation, nav.closeNavigation and library.addFiles`, () => {
      const messages = JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              `../../../lib/i18n/locales/${locale}.json`,
              import.meta.url,
            ),
          ),
          'utf8',
        ),
      ) as { nav: Record<string, string>; library: Record<string, string> };
      expect(messages.nav.openNavigation).toMatch(/\S/);
      expect(messages.nav.closeNavigation).toMatch(/\S/);
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
    readFileSync(
      fileURLToPath(new URL(`../${name}.tsx`, import.meta.url)),
      'utf8',
    );

  for (const name of ['agents', 'skills', 'shows']) {
    it(`${name}.tsx renders DrawerToggle first in its header row`, () => {
      const source = page(name);
      expect(source).toMatch(/from ["']@\/components\/ui\/drawer-toggle["']/);
      // The toggle is rendered, and it precedes the page's title in the file.
      const toggleAt = source.indexOf('<DrawerToggle />');
      const titleAt = source.indexOf('text-2xl font-bold');
      expect(toggleAt, `${name}.tsx renders <DrawerToggle />`).toBeGreaterThan(
        -1,
      );
      expect(toggleAt, 'and before the title').toBeLessThan(titleAt);
    });
  }

  it('notifications.tsx already has its own way out (a back control)', () => {
    expect(page('notifications')).toContain('router.back()');
  });

  /**
   * The guard left `_layout.tsx` and left `useDrawerStatus`, which went with the
   * expo-router `Drawer` itself. `AiChatShell` publishes `navPresented` in its
   * place — true in flow, and below `lg` only while the drawer is open — so what
   * was four `toContain`s over a file's text is now a component MOUNTED on both
   * of its branches, plus one text pin that it is actually installed. A guard
   * that works and is not wired is the same bug as no guard.
   */
  it('is wired around the drawer copy of the sidebar', () => {
    const layout = page('_layout');
    expect(layout).toContain("from '@/components/app-shell/nav-region'");
    // The template's two sidebars: the column from `lg` up, and the drawer
    // copy below it. Only the drawer can be closed while mounted, so the gate
    // wraps that one; in flow `navPresented` is always true.
    expect(layout).toMatch(/<NavRegion>\s*<Sidebar mobile \/>\s*<\/NavRegion>/);
    expect(layout).toContain('sidebar={sidebar}');
    expect(layout).toContain('mobileSidebar={mobileSidebar}');
  });

  it('takes the sidebar out of the accessibility tree AND the tab order while closed', () => {
    shell.current = shellWith(false);
    const r = mount(
      React.createElement(NavRegion, null, React.createElement('Rows')),
    );
    const region = r.root.find((node) => isHost(node, 'View'));

    expect(region.props['aria-hidden']).toBe(true);
    expect(region.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(region.props.accessibilityElementsHidden).toBe(true);
    /*
     * The half that neither `aria-hidden` nor the shell's own
     * `pointerEvents="none"` covers. `aria-hidden` stops a screen reader
     * announcing the rows and does nothing about Tab reaching them, and
     * reachable-but-unannounced IS #532. `inert` is the one attribute that says
     * both at once, and react-native-web forwards it.
     */
    expect(region.props.inert).toBe(true);

    // Gated, not unmounted — which is the whole reason gating is necessary.
    expect(r.root.findAll((node) => isHost(node, 'Rows'))).toHaveLength(1);
    act(() => r.unmount());
  });

  it('puts it back the moment the drawer is presented', () => {
    shell.current = shellWith(true);
    const r = mount(
      React.createElement(NavRegion, null, React.createElement('Rows')),
    );
    const region = r.root.find((node) => isHost(node, 'View'));

    expect(region.props['aria-hidden']).toBe(false);
    expect(region.props.importantForAccessibility).toBe('auto');
    expect(region.props.accessibilityElementsHidden).toBe(false);
    expect(region.props.inert).toBeUndefined();
    act(() => r.unmount());
  });

  it('hides nothing when there is no shell — there is no drawer to be behind', () => {
    shell.current = null;
    const r = mount(
      React.createElement(NavRegion, null, React.createElement('Rows')),
    );
    const region = r.root.find((node) => isHost(node, 'View'));

    expect(region.props['aria-hidden']).toBe(false);
    expect(region.props.inert).toBeUndefined();
    act(() => r.unmount());
  });
});

vi.mock('@oxy.so/bloom/icons', () => ({ RiFileTextLine: () => null, RiImageLine: () => null }));
