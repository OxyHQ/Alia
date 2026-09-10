import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings header on a phone, with a subtitle that wraps.
 *
 * Connectors at 390×844 (and at 320×740) rendered its title with the top six
 * pixels above the viewport: the header was exactly `56 + insets.top` tall, its
 * row was centred, and the title's 28px over a two-line subtitle's 40px is 68px,
 * so the overflow was split above and below (#550). The fixture is that screen —
 * "Connectors" with its subtitle — and what is pinned is that the header has a
 * MINIMUM height and no fixed one, that the subtitle sits under the title in a
 * block nothing has fixed the height of, and that the controls are pinned to the
 * title line rather than to the centre of the block. `DrawerToggle` renders for
 * real: it is one of those controls.
 *
 * The back control is decided by the layout mode (#548), which is the same
 * header and the same row, so it is pinned here too.
 */

const toggleDrawer = vi.hoisted(() => vi.fn());
const back = vi.hoisted(() => vi.fn());

/** An iPhone with a notch, which is where the title went missing. */
const TOP_INSET = 47;

vi.mock('expo-router', () => ({
  useNavigation: () => ({ toggleDrawer }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back, canGoBack: () => true }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View') };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: TOP_INSET, bottom: 34, left: 0, right: 0 }),
}));

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
vi.mock('@/components/ui/icons/menu-icon', async () => {
  const ReactModule = await import('react');
  return { MenuIcon: (props: Record<string, unknown>) => ReactModule.createElement('MenuIcon', props) };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return { ArrowLeft: (props: Record<string, unknown>) => ReactModule.createElement('ArrowLeft', props) };
});

vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }) };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));
// `@/lib/utils` owns `cn`, which `DrawerToggle` really uses, and a UUID helper
// that pulls the Expo native module in on import. The leaf is stubbed.
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

import { SettingsHeader } from '../settings/settings-header';
import { SettingsLayoutContext, type SettingsLayoutMode } from '../settings/layout-mode';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOST_VIEW: string = 'View';
const HOST_TEXT: string = 'Text';
const HOST_BUTTON: string = 'Button';

const TITLE = 'Connectors';
const SUBTITLE = 'Connect apps and services so Alia can act on your behalf';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  back.mockReset();
});

/** A style prop as one object, whichever of RN's shapes it came in. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

function render(
  props: Partial<React.ComponentProps<typeof SettingsHeader>> = {},
  mode: SettingsLayoutMode | null = 'stacked',
) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <SettingsLayoutContext.Provider value={mode}>
        <SettingsHeader title={TITLE} subtitle={SUBTITLE} {...props} />
      </SettingsLayoutContext.Provider>,
    );
  });
  if (next === undefined) throw new Error('the settings header did not render');
  renderer = next;
  const root = next.root.find((node) => node.type === HOST_VIEW && node.parent?.type !== HOST_VIEW);
  const texts = next.root.findAll((node) => node.type === HOST_TEXT);
  return { r: next, root, texts };
}

/** The `View` ancestors of a node, nearest first, up to the header's root. */
function viewAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const chain: ReactTestInstance[] = [];
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === HOST_VIEW) chain.push(cursor);
  }
  return chain;
}

describe('the Connectors header on a phone', () => {
  it('has a minimum height and no fixed one, with the safe area as padding', () => {
    const { root } = render();
    const style = flatten(root.props.style);
    expect(style.height).toBeUndefined();
    expect(style.minHeight).toBe(56 + TOP_INSET);
    // The notch is padding above the content, never part of a fixed box.
    expect(style.paddingTop).toBeGreaterThanOrEqual(TOP_INSET);
    expect(style.paddingBottom).toBeGreaterThan(0);
  });

  it('renders the subtitle under the title, and nothing on the way up fixes its height', () => {
    const { texts } = render();
    const title = texts.findIndex((node) => node.props.children === TITLE);
    const subtitle = texts.findIndex((node) => node.props.children === SUBTITLE);
    expect(title).toBeGreaterThan(-1);
    expect(subtitle).toBeGreaterThan(title);
    // A wrapped subtitle grows the header rather than overflowing it: no `View`
    // between it and the root may set a numeric `height`. Positive control on
    // the walk: it reaches the root, which sets the `minHeight` above.
    const chain = viewAncestors(texts[subtitle]);
    expect(chain.length).toBeGreaterThan(0);
    expect(flatten(chain[chain.length - 1].props.style).minHeight).toBe(56 + TOP_INSET);
    for (const view of chain) {
      expect(typeof flatten(view.props.style).height).not.toBe('number');
    }
  });

  it('keeps the drawer opener level with the title line, not the centre of the block', () => {
    const { root, texts } = render();
    // The row aligns to its top, and the title line is one control tall, so the
    // 36px buttons and the title share a centre however long the subtitle runs.
    expect(String(root.props.className)).toContain('items-start');
    expect(String(root.props.className)).not.toContain('items-center');
    const title = texts.find((node) => node.props.children === TITLE);
    if (title === undefined) throw new Error('no title');
    // The nearest `View` — the host `Text`'s own parent is the mocked component.
    const [titleLine] = viewAncestors(title);
    expect(String(titleLine.props.className)).toContain('min-h-9');
    expect(String(titleLine.props.className)).toContain('justify-center');
    const opener = root.findAll(
      (node) => node.type === HOST_BUTTON && node.props.accessibilityLabel === 'nav.openNavigation',
    );
    expect(opener).toHaveLength(1);
    expect(String(opener[0].props.className)).toContain('h-9');
    act(() => opener[0].props.onPress());
    expect(toggleDrawer).toHaveBeenCalledTimes(1);
  });

  it('still renders without a subtitle', () => {
    const { texts } = render({ subtitle: undefined });
    expect(texts.map((node) => node.props.children)).toEqual([TITLE]);
  });
});

describe('the way back to the category menu', () => {
  const backButton = (r: ReactTestRenderer) =>
    r.root.findAll(
      (node) => node.type === HOST_BUTTON && node.props.accessibilityLabel === 'common.back',
    );

  it('is there when the layout is stacked, and goes back', () => {
    const { r } = render({ showBack: true }, 'stacked');
    const buttons = backButton(r);
    expect(buttons).toHaveLength(1);
    act(() => buttons[0].props.onPress());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('is not there when the column is beside the pane, nor before the scene is measured', () => {
    // The column IS the menu in split mode, and the index this would return to
    // redirects straight back. Unmeasured: never shown only to vanish.
    for (const mode of ['split', null] as const) {
      const { r } = render({ showBack: true }, mode);
      expect(backButton(r)).toHaveLength(0);
      act(() => renderer?.unmount());
      renderer = null;
    }
  });

  it('is never there unless the screen asked for it', () => {
    const { r } = render({ showBack: false }, 'stacked');
    expect(backButton(r)).toHaveLength(0);
  });
});
