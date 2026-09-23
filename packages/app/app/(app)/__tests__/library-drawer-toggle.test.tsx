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
 * The Library stands on the layout's surface, and its "+" has a name.
 *
 * At 390×844 the Library page once rendered a title, a "+", a search box and
 * four filter chips — and no way back to the sidebar but a swipe nobody is told
 * about (#532). The page then grew its own `DrawerToggle`. The way out now
 * belongs to the app layout: every non-chat route is wrapped in Bloom's
 * `AiChatContainer`, whose `AiChatMobileHeader` carries the menu button and
 * whose crumb carries the section title. What is pinned here is that the page
 * no longer draws a second opener, a second title or a surface of its own, and
 * that the layout really does wrap it — because a page that dropped its opener
 * before the layout grew one would be #532 again.
 *
 * The "+" had no accessible name either (#536), so that is pinned in the same
 * file: it is the same header, and the same class of mistake.
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
vi.mock('@oxy.so/bloom/chip', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { Chip: host('Chip'), ChipRow: host('ChipRow') };
});
vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: (props: Record<string, unknown>) =>
      ReactModule.createElement('EmptyState', props),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { Text: host('Text'), Muted: host('Muted') };
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
    Row: shape('Skeleton'),
    Col: shape('Skeleton'),
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

describe("the Library on the layout's surface", () => {
  it('draws no drawer toggle of its own — the layout header owns it', async () => {
    const { root } = await renderLibrary();

    expect(buttonsLabelled(root, 'nav.openNavigation')).toHaveLength(0);
    expect(root.findAll((node) => isHost(node, 'MenuIcon'))).toHaveLength(0);
    // Rendered inside a live nav, so an opener would have had a drawer to open.
    expect(navToggle).not.toHaveBeenCalled();
  });

  it('draws no title of its own — the crumb says "Library"', async () => {
    const { root } = await renderLibrary();

    expect(
      root.findAll((node) => node.props.children === 'library.title'),
    ).toHaveLength(0);
    // Its one-line description stays, as Bloom's secondary text.
    expect(
      root.findAll(
        (node) =>
          isHost(node, 'Muted') && node.props.children === 'library.subtitle',
      ),
    ).toHaveLength(1);
  });

  it('paints no surface: no ContentPanel, no className, no background', async () => {
    const { root } = await renderLibrary();

    expect(root.findAll((node) => isHost(node, 'ContentPanel'))).toHaveLength(0);
    const styled = root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        (node.props.className !== undefined ||
          node.props.surfaceClassName !== undefined),
    );
    expect(styled, 'no NativeWind classes on the page').toHaveLength(0);
    const painted = root.findAll((node) => {
      if (typeof node.type !== 'string') return false;
      const style = node.props.style as Record<string, unknown> | undefined;
      return Boolean(
        style && (style.backgroundColor !== undefined || style.borderRadius !== undefined),
      );
    });
    expect(painted, 'no background or corner on the page').toHaveLength(0);
  });

  it('filters by category through Bloom chips, one selected at a time', async () => {
    const { root } = await renderLibrary();

    const chips = () => root.findAll((node) => isHost(node, 'Chip'));
    expect(chips().map((chip) => chip.props.children)).toEqual([
      'common.all',
      'library.documents',
      'library.images',
      'library.other',
    ]);
    expect(chips().filter((chip) => chip.props.selected)).toHaveLength(1);
    expect(chips()[0].props.selected).toBe(true);

    await act(async () => {
      (chips()[2].props.onPress as () => void)();
    });
    expect(chips()[2].props.selected).toBe(true);
    expect(chips()[0].props.selected).toBe(false);
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
    it(`${locale}: nav.openNavigation, nav.closeNavigation, library.addFiles and pages.library.*`, () => {
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
      ) as {
        nav: Record<string, string>;
        library: Record<string, string>;
        pages: { library: { categories: string; resultCount: Record<string, string> } };
      };
      expect(messages.nav.openNavigation).toMatch(/\S/);
      expect(messages.nav.closeNavigation).toMatch(/\S/);
      expect(messages.library.addFiles).toMatch(/\S/);
      expect(messages.pages.library.categories).toMatch(/\S/);
      expect(messages.pages.library.resultCount.one).toMatch(/\S/);
      expect(messages.pages.library.resultCount.other).toContain('{{count}}');
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

  /**
   * Agents stands on the same container; only the opener is pinned here, the
   * rest of that page belongs to its own tests.
   */
  it('agents.tsx leaves the opener to the layout', () => {
    const source = page('agents');
    expect(source).not.toMatch(/drawer-toggle/);
    expect(source).not.toContain('<DrawerToggle');
  });

  /**
   * Skills stands on the layout's `AiChatContainer`, whose mobile header owns
   * the menu button and whose crumb owns the title. A second opener, or a
   * second title, on the page itself is the duplicate this guards against.
   */
  it('skills.tsx leaves the opener and the title to the layout', () => {
    const source = page('skills');
    expect(source).not.toMatch(/drawer-toggle/);
    expect(source).not.toContain('<DrawerToggle');
    expect(source).not.toContain("t('skills.title')");
  });

  for (const name of ['library', 'shows']) {
    it(`${name}.tsx leaves the opener, the title and the surface to the layout`, () => {
      const source = page(name);
      expect(source).not.toMatch(/drawer-toggle/);
      expect(source).not.toContain('<DrawerToggle');
      expect(source).not.toContain('ContentPanel');
      expect(source).not.toContain('className');
    });
  }

  /**
   * The other half of the pages above: the layout really does give every
   * non-chat route the opener. `screenLayout` wraps it in `AiChatContainer`
   * with `AiChatMobileHeader` as its header, and only the chat routes (which
   * compose their own container) are let through bare.
   */
  it("wraps every non-chat route in the container whose header has the opener", () => {
    const layout = page('_layout');
    expect(layout).toContain('screenLayout={screenLayout}');
    expect(layout).toMatch(/<AiChatContainer[\s\S]*header=\{<AiChatMobileHeader/);
    expect(layout).toMatch(/PAGE_TITLES[\s\S]*library: 'sidebar\.library'/);
    expect(layout).toMatch(/shows: 'sidebar\.shows'/);
  });

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

vi.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', () => ({ RiFileTextLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiFolderLine', () => ({ RiFolderLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiImageLine', () => ({ RiImageLine: () => null }));
