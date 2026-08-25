import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What an agent's face is painted with.
 *
 * The color comes from `User.color` on the agent's Oxy bot account — a column
 * whose format Alia does not control, reached through a lookup that FAILS OPEN
 * and returns null for an account it cannot resolve. So the two paths that
 * matter are "a color arrived" and "nothing usable arrived", and the second is
 * ordinary traffic.
 *
 * The failure this pins down is silent: `withAlpha` hands back an unparseable
 * color UNCHANGED, and an SVG `fill` that SVG cannot parse renders BLACK. A
 * garbage color would therefore paint a black disc and a black flower on every
 * theme, which looks like a design choice rather than a bug — so it is asserted
 * to take the same path as no color at all.
 */

const MUTED = 'rgb(113 113 122)';

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: MUTED } }),
}));

/**
 * Bloom's `theme` entry is a barrel that reaches `react-native` — which has no
 * Node build — through directory imports Node's ESM resolver refuses outright.
 * The two color utilities this component uses are a standalone module inside the
 * SAME install, so they are loaded from there: what runs here is Bloom's own
 * `parseRgb` and `withAlpha`, and a test of a re-implementation of them would
 * measure nothing.
 */
vi.mock('@oxyhq/bloom/theme', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const entry = pathToFileURL(require.resolve('@oxyhq/bloom'));
  return require(new URL('theme/color-utils.js', entry).pathname);
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    G: host('G'),
    Path: host('Path'),
  };
});

import { AgentGlyph } from '../agent-glyph';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(props: React.ComponentProps<typeof AgentGlyph>) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<AgentGlyph {...props} />);
  });
  if (next === undefined) throw new Error('AgentGlyph did not render');
  renderer = next;
  return next.root;
}

function nodes(root: ReturnType<typeof render>, name: string) {
  return root.findAll((node) => node.type === name);
}

/** The flower fill and the disc fill, in that order. */
function fills(root: ReturnType<typeof render>) {
  return {
    flower: nodes(root, 'Path')[0]?.props.fill,
    disc: nodes(root, 'Circle')[0]?.props.fill,
  };
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('AgentGlyph', () => {
  it("paints the flower and its disc in the agent's own color", () => {
    expect(fills(render({ color: '#7c3aed' }))).toEqual({
      flower: '#7c3aed',
      disc: 'rgba(124, 58, 237, 0.16)',
    });
  });

  it('accepts the rgb form Bloom itself emits, not only hex', () => {
    expect(fills(render({ color: 'rgb(255 0 0)' }))).toEqual({
      flower: 'rgb(255 0 0)',
      disc: 'rgba(255, 0, 0, 0.16)',
    });
  });

  it.each([
    // Oxy resolved the account but it has no color set.
    ['null', null],
    // Oxy resolved nothing at all: the identity lookup failed open.
    ['undefined', undefined],
    // A stored value that is not a color. Untrusted, and the reason for parsing:
    // passed through, it would paint black.
    ['a word', 'sunset'],
    // The empty string a form can write into the column.
    ['an empty string', ''],
  ])('falls back to the theme when the color is %s', (_label, color) => {
    expect(fills(render({ color }))).toEqual({
      flower: MUTED,
      disc: 'rgba(113, 113, 122, 0.16)',
    });
  });

  it('names itself only when it stands for someone', () => {
    expect(nodes(render({ label: 'Pepe' }), 'Svg')[0]?.props.accessibilityLabel).toBe('Pepe');
    expect(nodes(render({}), 'Svg')[0]?.props).not.toHaveProperty('accessibilityLabel');
  });

  it('renders at the size it is given, square', () => {
    const svg = nodes(render({ size: 20 }), 'Svg')[0]?.props;
    expect(svg).toMatchObject({ width: 20, height: 20, viewBox: '0 0 100 100' });
  });
});
