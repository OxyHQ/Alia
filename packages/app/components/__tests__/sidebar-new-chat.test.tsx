import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * New Chat: where it sits, and what it looks like.
 *
 * Two separate claims, checked in the two different places they are actually
 * decided. WHERE it sits is decided by `BaseSidebar`, which renders its
 * `topSection` before its `navigation` — so that is rendered, not read. WHAT it
 * looks like is a set of classes on one element inside a 992-line component
 * whose render pulls in some thirty modules; those are read off the source,
 * and the pixels they produce are measured separately in Chromium.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

vi.mock('expo-linear-gradient', async () => {
  const ReactModule = await import('react');
  return {
    LinearGradient: (props: Record<string, unknown>) =>
      ReactModule.createElement('LinearGradient', props),
  };
});

vi.mock('@oxyhq/bloom/theme', () => ({ withAlpha: (color: string) => color }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { background: 'rgb(255,255,255)', surface: 'rgb(250,250,250)' } }),
}));

// `@/lib/utils` owns `cn`, which `BaseSidebar` really uses, and also a UUID
// helper that pulls the Expo native module in on import. The leaf is stubbed so
// the real `cn` survives.
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

import { View } from 'react-native';

import { BaseSidebar } from '../base-sidebar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

/** The mocked host name, as a value: comparing `node.type` to a literal does not narrow. */
const HOST_VIEW: string = 'View';

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('where New Chat sits', () => {
  /**
   * Sentinels rather than the real sections: what is under test is the ORDER
   * `BaseSidebar` puts its two slots in, and a sentinel cannot accidentally
   * satisfy it by rendering something that happens to look right.
   */
  function renderSlots(collapsed: boolean) {
    let next: ReactTestRenderer | undefined;
    act(() => {
      next = create(
        <BaseSidebar
          collapsed={collapsed}
          header={<View testID="marker-header" />}
          topSection={<View testID="marker-new-chat" />}
          navigation={<View testID="marker-agents" />}
          footer={<View testID="marker-footer" />}
        />,
      );
    });
    if (next === undefined) throw new Error('the sidebar did not render');
    renderer = next;
    const order = next.root
      .findAll(
        (node) =>
          node.type === HOST_VIEW && String(node.props.testID ?? '').startsWith('marker-'),
      )
      .map((node) => String(node.props.testID));
    return order;
  }

  it('puts the top section before the navigation, open and in the rail', () => {
    // The rail and the open sidebar are the same tree with a flag, so both are
    // asserted rather than assuming one stands for the other.
    for (const collapsed of [false, true]) {
      const order = renderSlots(collapsed);
      expect(order).toContain('marker-new-chat');
      expect(order).toContain('marker-agents');
      expect(order.indexOf('marker-new-chat')).toBeLessThan(order.indexOf('marker-agents'));
      act(() => renderer?.unmount());
      renderer = null;
    }
  });
});

describe('the sidebar hands its slots over the right way round', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../sidebar.tsx', import.meta.url)),
    'utf8',
  );

  /** The body of a `const <name> = (…)` block, by brace-free slicing to the next `const `. */
  function block(name: string): string {
    const start = source.indexOf(`const ${name} = (`);
    if (start === -1) throw new Error(`no ${name} block in the sidebar`);
    const next = source.indexOf('\n  const ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it('renders New Chat in the top section and Agents in the navigation', () => {
    // Ordering is only New-Chat-before-Agents if the two live in those two
    // slots; the render test above proves what the slots do with them.
    expect(block('topSection')).toContain('{newChatButton}');
    expect(block('navigation')).toContain("t('sidebar.agents')");
    // Positive control on the slicer: a block it failed to find would be empty
    // and every `toContain` above it vacuous.
    expect(block('topSection').length).toBeGreaterThan(0);
    expect(block('navigation')).not.toContain('{newChatButton}');
  });
});

describe('what New Chat looks like', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../sidebar.tsx', import.meta.url)),
    'utf8',
  );
  const button = source.slice(
    source.indexOf('const newChatButton = ('),
    source.indexOf('const topSection = ('),
  );

  it('is a filled pill rather than a muted row', () => {
    // Positive control on the slice: an empty one would pass every assertion
    // that follows by having nothing to contradict them.
    expect(button).toContain('accessibilityLabel');
    expect(button).toContain('rounded-full');
    expect(button).toContain('bg-primary');
    // The old shape, which is what this replaced.
    expect(button).not.toContain('rounded-xl');
    expect(button).not.toContain('bg-muted');
  });

  it('is full width with a centred label and no icon when the sidebar is open', () => {
    expect(button).toContain('w-full py-3');
    expect(button).toContain('text-center');
    expect(button).toContain('text-[17px]');
    expect(button).toContain('font-extrabold');
    expect(button).toContain('text-primary-foreground');
  });

  it('is a circle that fits the rail when collapsed', () => {
    // The rail is 56px (`app/(app)/_layout.tsx`), so 50 leaves three either
    // side. The browser measurement pins that it actually fits.
    expect(button).toContain('h-[50px] w-[50px]');
    expect(button).toContain('size={26}');
  });

  it('still opens a new chat, and still explains itself in the rail', () => {
    // The one thing that may not change, plus the tooltip that only exists
    // while the label is hidden.
    expect(button).toContain('onPress={handleNewChat}');
    expect(button).toContain('newChatTooltip.anchorProps');
  });
});
