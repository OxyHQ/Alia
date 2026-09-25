import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ambient field is decoration, and it behaves like it (#608 §3.1).
 *
 * - It is out of the accessibility tree and takes no touch.
 * - Its two endless loops stop while nobody can see it — its screen covered by
 *   another route, the app in the background, the tab hidden — and pick up
 *   where they stopped.
 * - With reduced motion on, the pointer parallax is off. (The loops and the
 *   entrance are Reanimated's to resolve at once under `ReduceMotion.System`;
 *   the component's doc says how.)
 *
 * Reanimated is replaced by a recorder: each `with*` call returns a plain
 * description of the animation, and `cancelAnimation` notes what it stopped.
 * What is asserted is which animations the component ASKS for, which is the
 * part it owns; that Reanimated runs them is Reanimated's.
 */

type Described =
  | { kind: 'timing'; to: number; duration: number | undefined }
  | { kind: 'delay'; delay: number; animation: Described }
  | { kind: 'repeat'; animation: Described; reps: number; reverse: boolean }
  | { kind: 'sequence'; steps: Described[] };

const rea = vi.hoisted(() => ({
  reduce: false,
  cancelled: new Set<object>(),
  values: [] as Array<{ value: unknown }>,
}));

const appState = vi.hoisted(() => ({
  current: 'active' as string,
  listener: null as null | ((state: string) => void),
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const AnimatedView = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement('AnimatedView', props, children);
  return {
    default: { View: AnimatedView },
    Easing: { bezier: () => 'bezier', linear: 'linear', inOut: () => 'inOut', sin: 'sin' },
    useSharedValue: (initial: unknown) => {
      const ref = ReactModule.useRef<{ value: unknown } | null>(null);
      if (ref.current === null) {
        ref.current = { value: initial };
        rea.values.push(ref.current);
      }
      return ref.current;
    },
    useAnimatedStyle: (build: () => unknown) => build(),
    useAnimatedReaction: () => undefined,
    useReducedMotion: () => rea.reduce,
    cancelAnimation: (value: object) => {
      rea.cancelled.add(value);
    },
    withTiming: (to: number, config?: { duration?: number }): Described => ({
      kind: 'timing',
      to,
      duration: config?.duration,
    }),
    withDelay: (delay: number, animation: Described): Described => ({ kind: 'delay', delay, animation }),
    withRepeat: (animation: Described, reps: number, reverse: boolean): Described => ({
      kind: 'repeat',
      animation,
      reps,
      reverse,
    }),
    withSequence: (...steps: Described[]): Described => ({ kind: 'sequence', steps }),
  };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
    Platform: { OS: 'web' },
    AppState: {
      get currentState() {
        return appState.current;
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listener = listener;
        return { remove: () => { appState.listener = null; } };
      },
    },
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children }: React.PropsWithChildren) =>
    ReactModule.createElement(name, null, children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Defs: host('Defs'),
    RadialGradient: host('RadialGradient'),
    Rect: host('Rect'),
    Stop: host('Stop'),
  };
});

import { AmbientField } from '@/features/chat/ui/ambient-field';

/** The loops a blob asks for: its float (a lap, delayed or not) and its beat. */
function isLoop(value: unknown): boolean {
  const described = value as Described | undefined;
  if (typeof described !== 'object' || described === null) return false;
  if (described.kind === 'repeat') return described.reps === -1;
  if (described.kind === 'delay') return isLoop(described.animation);
  return false;
}

function isResume(value: unknown): value is Extract<Described, { kind: 'sequence' }> {
  const described = value as Described | undefined;
  return typeof described === 'object' && described !== null && described.kind === 'sequence';
}

function mount(props: React.ComponentProps<typeof AmbientField> = {}) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(AmbientField, props));
  });
  const root = renderer.root.findByType('View' as never);
  // The blobs are laid out against the measured field.
  act(() => {
    (root.props as { onLayout: (e: unknown) => void }).onLayout({
      nativeEvent: { layout: { width: 1000, height: 800 } },
    });
  });
  return {
    renderer,
    root,
    update(next: React.ComponentProps<typeof AmbientField>) {
      act(() => {
        renderer.update(React.createElement(AmbientField, next));
      });
    },
    loops: () => rea.values.filter((sv) => isLoop(sv.value)),
  };
}

beforeEach(() => {
  rea.reduce = false;
  rea.cancelled.clear();
  rea.values = [];
  appState.current = 'active';
  appState.listener = null;
});

describe('AmbientField is decoration', () => {
  it('is hidden from screen readers and lets every touch through', () => {
    const { root } = mount();
    const props = root.props as Record<string, unknown>;
    // react-native-web writes it as is; React Native maps it to
    // accessibilityElementsHidden and importantForAccessibility.
    expect(props['aria-hidden']).toBe(true);
    expect(props.pointerEvents).toBe('none');
  });
});

describe('AmbientField stops while nobody can see it', () => {
  it('runs a float and a beat per blob while on show', () => {
    const field = mount();
    // Three blobs, two endless loops each.
    expect(field.loops()).toHaveLength(6);
    expect(rea.cancelled.size).toBe(0);
  });

  it('cancels every loop while its screen is covered, and resumes each from where it stopped', () => {
    const field = mount();
    const loops = field.loops();

    field.update({ paused: true });
    for (const loop of loops) expect(rea.cancelled.has(loop)).toBe(true);

    // Stopped part-way: the float a quarter into its lap, the beat mid-swing.
    for (const loop of loops) loop.value = 0.25;
    field.update({ paused: false });

    for (const loop of loops) {
      expect(isResume(loop.value)).toBe(true);
      const [first] = (loop.value as Extract<Described, { kind: 'sequence' }>).steps;
      // The rest of the lap or swing first — three quarters of it — not a restart.
      expect(first).toMatchObject({ kind: 'timing', to: 1 });
      expect((first as { duration: number }).duration).toBeGreaterThan(0);
      const last = (loop.value as Extract<Described, { kind: 'sequence' }>).steps.at(-1);
      expect(isLoop(last)).toBe(true);
    }
    // The first blob's float: 8000ms laps, so 6000ms left.
    const firstFloat = loops.find(
      (loop) => ((loop.value as Extract<Described, { kind: 'sequence' }>).steps[0] as { duration: number }).duration === 6000,
    );
    expect(firstFloat).toBeDefined();
  });

  it('stops while the app is in the background or the tab is hidden', () => {
    const field = mount();
    const loops = field.loops();

    act(() => appState.listener?.('background'));
    for (const loop of loops) expect(rea.cancelled.has(loop)).toBe(true);

    act(() => appState.listener?.('active'));
    for (const loop of loops) expect(isResume(loop.value)).toBe(true);
  });

  it('does not start its loops on a screen that mounts covered, until it is shown', () => {
    const field = mount({ paused: true });
    expect(field.loops()).toHaveLength(0);

    field.update({ paused: false });
    expect(field.loops()).toHaveLength(6);
  });
});

describe('AmbientField with reduced motion', () => {
  function parallaxOffsets(renderer: ReactTestRenderer): number[] {
    return renderer.root
      .findAllByType('AnimatedView' as never)
      .flatMap((node) => {
        const style = (node.props as { style?: unknown[] }).style;
        const layers = Array.isArray(style) ? style : [];
        return layers.flatMap((layer) => {
          const transform = (layer as { transform?: Array<Record<string, number>> } | null)?.transform;
          return transform?.map((step) => step.translateX).filter((x) => x !== undefined) ?? [];
        });
      });
  }

  it('follows the pointer normally, and not at all with reduced motion on', () => {
    const pointerX = { value: 1 } as never;
    const pointerY = { value: 0 } as never;

    const moving = mount({ pointerX, pointerY });
    // The first blob's reach at the pointer's right edge is 120px.
    expect(parallaxOffsets(moving.renderer)).toContain(120);

    rea.reduce = true;
    const still = mount({ pointerX, pointerY });
    expect(parallaxOffsets(still.renderer)).not.toContain(120);
  });
});
