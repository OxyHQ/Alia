import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * When the panel offers a grip, and what it hands Bloom when it does.
 *
 * `AiChatResizeHandle` is the AI Chat template's own separator: a strip
 * straddling the edge that reveals a grip under the pointer, keeps it up while
 * dragging, reports the distance from where the drag began, and exposes itself
 * as a `separator` with a keyboard nudge. Reimplementing that locally is
 * exactly what #608 §11 is about, so it is adopted rather than copied.
 *
 * Bloom owns how the grip behaves; `Panel` owns WHETHER there is one and what
 * it is told. That second question is the one with the decisions in it, and the
 * one tested here:
 *
 * - a grip appears only when something can act on the drag, because a handle
 *   over a fixed width is a control wired to nothing (#608 §1.6);
 * - only on the right, the edge shared with the chat — the left borders
 *   nothing to trade width with;
 * - never on a narrow screen, where the panel is a near-full-bleed sheet and
 *   there is no second column;
 * - and the translated name reaches it, because a separator is a control and
 *   an unnamed one is unusable by anyone not looking at it.
 *
 * Bloom is stubbed at its module boundary rather than mounted. The barrel
 * `@oxy.so/bloom/ai-chat` drags in the overlay and styled-primitive graph and
 * the whole native Expo surface under it; mounting it here would make this a
 * test of that scaffolding rather than of the four decisions above. Where
 * mounting a real Bloom component IS the subject, it is mounted — see
 * `components/__tests__/message-block-boundary.test.tsx`.
 */

const layout = vi.hoisted(() => ({ isLargeScreen: true }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
  };
});

vi.mock('@oxy.so/bloom/ai-chat', async () => {
  const ReactModule = await import('react');
  return {
    AiChatResizeHandle: (props: Record<string, unknown>) =>
      ReactModule.createElement('AiChatResizeHandle', props),
  };
});

vi.mock('@/lib/hooks/use-is-large-screen', () => ({
  useIsLargeScreen: () => layout.isLargeScreen,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@oxy.so/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Dialog', null, children),
  };
});

vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));

import { Panel } from '@/components/ui/panel';

function render(props: Partial<React.ComponentProps<typeof Panel>> = {}) {
  let renderer: any;
  act(() => {
    renderer = create(
      React.createElement(Panel, {
        open: true,
        onClose: () => {},
        side: 'right',
        width: 380,
        children: React.createElement('PanelBody'),
        ...props,
      }),
    );
  });
  return renderer;
}

/** Every Bloom resize handle the panel mounted. */
function handles(renderer: any): any[] {
  return renderer.root.findAllByType('AiChatResizeHandle');
}

describe('Panel resize handle', () => {
  it('mounts the Bloom handle when the panel can be resized', () => {
    layout.isLargeScreen = true;
    const renderer = render({ onResize: () => {} });

    expect(handles(renderer)).toHaveLength(1);
  });

  it('offers no grip when nothing can act on the drag', () => {
    layout.isLargeScreen = true;
    const renderer = render();

    expect(handles(renderer)).toHaveLength(0);
  });

  it('offers no grip on the left edge, which borders nothing to trade with', () => {
    layout.isLargeScreen = true;
    const renderer = render({ side: 'left', onResize: () => {} });

    expect(handles(renderer)).toHaveLength(0);
  });

  it('offers no grip on a narrow screen, where the panel is a sheet', () => {
    layout.isLargeScreen = false;
    const renderer = render({ onResize: () => {} });

    expect(handles(renderer)).toHaveLength(0);
  });

  it('carries the translated name through to the separator', () => {
    layout.isLargeScreen = true;
    const renderer = render({ onResize: () => {}, resizeLabel: 'Redimensionar el panel' });

    const [handle] = handles(renderer);
    expect(handle.props.label).toBe('Redimensionar el panel');
  });

  it('still renders the panel body beside the grip', () => {
    layout.isLargeScreen = true;
    const renderer = render({ onResize: () => {} });

    expect(renderer.root.findAllByType('PanelBody')).toHaveLength(1);
  });
});
