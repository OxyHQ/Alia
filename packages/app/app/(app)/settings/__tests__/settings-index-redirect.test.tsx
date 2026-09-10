import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings index: a menu when the layout is stacked, a redirect when the
 * category column is already on screen, and neither on a guess.
 *
 * It used to redirect at `md`, the same window breakpoint that mounted the
 * column — so at 768 with the drawer open, where the column has now gone, it
 * would have redirected a tablet into the first section with no list to come
 * back to (#548). What is pinned is that the redirect follows the MODE the
 * layout measured, and that an unmeasured layout gets nothing at all.
 */

const push = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), ScrollView: host('ScrollView') };
});

vi.mock('expo-router', async () => {
  const ReactModule = await import('react');
  return {
    Redirect: (props: Record<string, unknown>) => ReactModule.createElement('Redirect', props),
    useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), canGoBack: () => false }),
  };
});

vi.mock('@oxy.so/bloom/settings-list', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { SettingsListGroup: host('SettingsListGroup'), SettingsListItem: host('SettingsListItem') };
});

/**
 * The header has its own test (`components/__tests__/settings-header-height`);
 * here it is a marker, so this file measures the redirect and nothing else.
 */
vi.mock('@/components/settings/settings-header', async () => {
  const ReactModule = await import('react');
  return {
    SettingsHeader: (props: Record<string, unknown>) =>
      ReactModule.createElement('SettingsHeader', props),
  };
});

// The section icons are SVG glyphs; a host stands in for the renderer they need.
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { default: host('Svg'), Path: host('Path') };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  return { Palette: glyph, Brain: glyph, Smartphone: glyph, Bot: glyph, Plug: glyph, HardDrive: glyph };
});

vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale: () => undefined }) };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));

import SettingsIndexScreen from '../index';
import { SettingsLayoutContext, type SettingsLayoutMode } from '@/components/settings/layout-mode';
import { FIRST_SETTINGS_SECTION, SETTINGS_SECTIONS } from '@/components/settings/sections';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOST_REDIRECT: string = 'Redirect';
const HOST_ITEM: string = 'SettingsListItem';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  push.mockReset();
});

function render(mode: SettingsLayoutMode | null) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <SettingsLayoutContext.Provider value={mode}>
        <SettingsIndexScreen />
      </SettingsLayoutContext.Provider>,
    );
  });
  if (next === undefined) throw new Error('the settings index did not render');
  renderer = next;
  return {
    redirects: next.root.findAll((node) => node.type === HOST_REDIRECT),
    items: next.root.findAll((node) => node.type === HOST_ITEM),
  };
}

describe('the settings index', () => {
  it('redirects to the first section only when the column is on screen', () => {
    const { redirects, items } = render('split');
    expect(redirects).toHaveLength(1);
    expect(redirects[0].props.href).toBe(FIRST_SETTINGS_SECTION);
    expect(items).toHaveLength(0);
  });

  it('is the menu when the layout is stacked, and its rows open the sections', () => {
    const { redirects, items } = render('stacked');
    expect(redirects).toHaveLength(0);
    expect(items).toHaveLength(SETTINGS_SECTIONS.length);
    // Positive control: the list is not empty by accident of the fixture.
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0);
    act(() => items[0].props.onPress());
    expect(push).toHaveBeenCalledWith(SETTINGS_SECTIONS[0].route);
  });

  it('commits to nothing while the scene is unmeasured', () => {
    // Neither: a redirect on a guess takes a phone away from the menu it asked
    // for, and the menu would flash for a frame on a desktop.
    const { redirects, items } = render(null);
    expect(redirects).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});
