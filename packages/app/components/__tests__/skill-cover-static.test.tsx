import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A skill cover on the catalogue path mounts no graphics runtime (#545).
 *
 * /skills froze Chrome because every cover was an animated Skia canvas: the
 * web facade lazy-loaded canvaskit.wasm and then sixty results became sixty
 * clocks over 3,240 shadowed cells. The property pinned here is stronger than
 * "animated is false": the static path is static BY CONSTRUCTION. The skia
 * package, its web loader, the skia canvas module and reanimated are all
 * mocked to THROW on import, so if any of them is reached by the web facade or
 * by a plain `<SkillCover>` the test fails at import time, and a hoisted
 * counter says so in numbers rather than in a stack trace.
 *
 * `Platform.OS` is `web` throughout: `animated` is never honoured there, so the
 * detail page's opt-in must not fetch the animated module either.
 */

const reached = vi.hoisted(() => ({ skia: 0, skiaWeb: 0, skiaCanvas: 0, reanimated: 0 }));

vi.mock('@shopify/react-native-skia', () => {
  reached.skia += 1;
  throw new Error('@shopify/react-native-skia was imported on the static path');
});
vi.mock('@shopify/react-native-skia/lib/module/web', () => {
  reached.skiaWeb += 1;
  throw new Error('LoadSkiaWeb was imported on the static path');
});
vi.mock('@/components/ui/skill-cover-canvas-skia', () => {
  reached.skiaCanvas += 1;
  throw new Error('the skia canvas module was imported on the static path');
});
vi.mock('react-native-reanimated', () => {
  reached.reanimated += 1;
  throw new Error('react-native-reanimated was imported on the static path');
});

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
  };
});
vi.mock('expo-linear-gradient', async () => {
  const ReactModule = await import('react');
  return {
    LinearGradient: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('LinearGradient', props, children),
  };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ isDarkColorScheme: false }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { SkillCover } = await import('@/components/ui/skill-cover');
const { default: WebCanvas } = await import('@/components/ui/skill-cover-canvas.web');
const { GRID_SIZE, hashSeed, generatePalette, generateGrid, computeCellColor } = await import(
  '@/components/ui/skill-cover-palette'
);

const CELLS = GRID_SIZE * Math.ceil(GRID_SIZE * 1.5);

/** The props `SkillCover` hands its canvas, built the same way it builds them. */
function canvasProps(seed: string, width = 110) {
  const height = width * 1.5;
  const rows = Math.ceil(GRID_SIZE * 1.5);
  const hash = hashSeed(seed);
  const palette = generatePalette(hash);
  const grid = generateGrid(hash, rows, GRID_SIZE);
  return {
    width,
    height,
    cellW: width / GRID_SIZE,
    cellH: height / rows,
    halfW: width / 2,
    halfH: height / 2,
    grid,
    palette,
    staticColors: grid.map((cell) => computeCellColor(0, cell, palette, true)),
    glowColor: '#000000',
    animated: true,
    lightMode: true,
    isDarkColorScheme: false,
  };
}

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement): ReactTestRenderer {
  let next!: ReactTestRenderer;
  act(() => {
    next = create(element);
  });
  renderer = next;
  return next;
}

/**
 * A host element by its mocked name. Compared through a `string`, because
 * `node.type` is `ElementType` and a literal beside it is a type error.
 */
function isHost(node: ReactTestInstance, name: string): boolean {
  return node.type === name;
}

/** Host nodes that would only exist if a Skia canvas had mounted. */
function canvasNodes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === 'string' && /^(Canvas|Rect|RoundedRect|Group|Shadow)$/.test(node.type));
}

function covers(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => isHost(node, 'View') && node.props.accessibilityRole === 'image');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('the web cover facade', () => {
  it('renders the deterministic static grid and nothing from skia', () => {
    const props = canvasProps('web-facade');
    const { root } = render(React.createElement(WebCanvas, props));

    const cells = root.findAll(
      (node) => isHost(node, 'View') && typeof node.props.style?.backgroundColor === 'string' && node.props.style?.width === props.cellW,
    );
    expect(cells).toHaveLength(CELLS);
    expect(cells.map((cell) => cell.props.style.backgroundColor)).toEqual(props.staticColors);
    expect(canvasNodes(root)).toHaveLength(0);
    expect(reached).toEqual({ skia: 0, skiaWeb: 0, skiaCanvas: 0, reanimated: 0 });
  });

  it('imports nothing from the skia package, statically or lazily', () => {
    // A source-level guard beside the runtime one: the runtime test proves the
    // module loaded without skia under THIS resolver; this proves no bundler
    // could see a skia import in it either.
    // Comments are allowed to NAME what the code must not import.
    const code = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const facade = code('../ui/skill-cover-canvas.web.tsx');
    const grid = code('../ui/skill-cover-static.tsx');
    const importsSkia = /from\s+["']@shopify\/react-native-skia|import\(\s*["'][^"']*skia|require\(\s*["'][^"']*skia|canvaskit/;
    expect(facade).not.toMatch(importsSkia);
    expect(grid).not.toMatch(importsSkia);
    expect(grid).not.toMatch(/from\s+["'](react-native-reanimated|expo-blur)["']/);
  });
});

describe('the catalogue cover', () => {
  it('mounts sixty covers with zero Skia canvases and no runtime import', () => {
    const shelf = React.createElement(
      React.Fragment,
      null,
      Array.from({ length: 60 }, (_, i) =>
        React.createElement(SkillCover, {
          key: `skill-${i}`,
          seed: `skill-${i}`,
          width: 110,
          title: `Skill ${i}`,
          author: 'someone',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }),
      ),
    );
    const { root } = render(shelf);

    expect(covers(root)).toHaveLength(60);
    expect(canvasNodes(root)).toHaveLength(0);
    // Every cover carries its full grid, so the fallback is the real picture
    // and not a placeholder waiting for a runtime.
    const cells = root.findAll((node) => isHost(node, 'View') && node.props.style?.width === 110 / GRID_SIZE);
    expect(cells).toHaveLength(60 * CELLS);
    // The title scrim is a gradient, never a blur view.
    expect(root.findAll((node) => isHost(node, 'BlurView'))).toHaveLength(0);
    expect(root.findAll((node) => isHost(node, 'LinearGradient'))).toHaveLength(60);
    expect(reached).toEqual({ skia: 0, skiaWeb: 0, skiaCanvas: 0, reanimated: 0 });
  });

  it('keeps a readable title without any renderer', () => {
    const { root } = render(React.createElement(SkillCover, { seed: 'plain', title: 'Plain title', author: 'me' }));
    const texts = root.findAll((node) => isHost(node, 'Text')).map((node) => node.props.children);
    expect(texts).toContain('Plain title');
    expect(texts).toContain('me');
    expect(root.findAll((node) => isHost(node, 'View') && node.props.accessibilityLabel === 'Plain title')).toHaveLength(1);
  });

  it('ignores the animated opt-in on web, so the animated module is never fetched', () => {
    const { root } = render(React.createElement(SkillCover, { seed: 'focused', title: 'Focused', animated: true }));
    expect(covers(root)).toHaveLength(1);
    expect(canvasNodes(root)).toHaveLength(0);
    // No Suspense boundary was even entered: the static grid is the content.
    expect(root.findAll((node) => node.type === React.Suspense)).toHaveLength(0);
    expect(reached).toEqual({ skia: 0, skiaWeb: 0, skiaCanvas: 0, reanimated: 0 });
  });
});
