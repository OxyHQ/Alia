import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What an agent's face is painted with.
 *
 * `User.color` on the agent's Oxy bot account holds a Bloom preset KEY — the
 * WORD `"violet"`, not a colour — and it is reached through a lookup that FAILS
 * OPEN and returns null for an account it cannot resolve. So the two paths that
 * matter are "a preset arrived" and "nothing usable arrived", and the second is
 * ordinary traffic rather than an error.
 *
 * Both failures this pins down are silent. Not resolving the preset paints every
 * agent in the theme's own grey, which looks exactly like the honest fallback.
 * And passing a value through unresolved is worse: `withAlpha` hands back a
 * colour it cannot parse UNCHANGED, and an SVG `fill` that SVG cannot parse
 * renders BLACK — a black disc on every theme, which looks like a design choice.
 */

const MUTED = 'rgb(113 113 122)';

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: MUTED } }),
}));

/**
 * Bloom's `theme` entry is a barrel that reaches `react-native` — which has no
 * Node build — through directory imports Node's ESM resolver refuses outright.
 * The colour utilities and the preset registry are standalone modules inside the
 * SAME install, so they are loaded from there: what runs here is Bloom's own
 * `parseRgb`, `withAlpha` and `APP_COLOR_PRESETS`, and asserting a colour
 * against a re-stated copy of the registry would measure nothing — it is
 * precisely the registry being stale that the assertions are for.
 */
vi.mock('@oxyhq/bloom/theme', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const entry = pathToFileURL(require.resolve('@oxyhq/bloom'));
  const from = (module: string) => require(new URL(`theme/${module}.js`, entry).pathname);
  return { ...from('color-utils'), ...from('color-presets') };
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

import { APP_COLOR_PRESETS, withAlpha } from '@oxyhq/bloom/theme';

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
  /**
   * The vocabulary `User.color` actually holds, and the one this whole feature
   * turns on: `POST /agents/generate` proposes a Bloom preset KEY, Oxy stores
   * that word, and it reaches this component as the word.
   *
   * Asserted against Bloom's own registry rather than a hex written here,
   * because a hex written here would keep passing after Bloom reseeded the
   * preset — which is the day every agent silently changes colour.
   */
  it("resolves the Bloom preset key Oxy stores into the colour it seeds", () => {
    const { hex } = APP_COLOR_PRESETS.violet;

    expect(fills(render({ color: 'violet' }))).toEqual({
      flower: hex,
      disc: withAlpha(hex, 0.16),
    });
    // Not the theme's own — the assertion above would pass on the fallback if
    // the preset happened to seed the same value.
    expect(hex).not.toBe(MUTED);
  });

  it("paints a literal colour too, for anything that wrote one to that column", () => {
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
    // A word that is not a preset and not a colour. Untrusted, and the reason
    // for checking at all: passed through, it would paint black.
    ['a word that is neither', 'sunset'],
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
