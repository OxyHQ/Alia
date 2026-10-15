import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Reanimated as its contract, driven by hand: a shared value is a stable `{ value }`, a reaction
 * is a (prepare, react) pair the test calls the way the UI thread would on each change.
 */
const reaction = vi.hoisted(() => ({
  prepare: null as null | (() => number),
  react: null as null | ((value: number, previous: number | null) => void),
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    useSharedValue: (initial: unknown) => ReactModule.useRef({ value: initial }).current,
    useAnimatedReaction: (
      prepare: () => number,
      react: (value: number, previous: number | null) => void,
    ) => {
      reaction.prepare = prepare;
      reaction.react = react;
    },
    runOnJS: (fn: unknown) => fn,
  };
});

import { useFocusWhenPresented } from '../../src/hooks/useFocusWhenPresented';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function Probe({
  progress,
  focus,
}: {
  progress: { value: number } | undefined;
  focus: () => void;
}) {
  useFocusWhenPresented(progress as SharedValue<number> | undefined, focus);
  return null;
}

function mount(progress: { value: number } | undefined, focus: () => void) {
  act(() => {
    renderer = create(<Probe progress={progress} focus={focus} />);
  });
}

/** The sheet's progress moves to `value`; the UI thread's reaction sees it. */
function moveTo(progress: { value: number }, value: number) {
  progress.value = value;
  const seen = reaction.prepare?.() ?? 0;
  reaction.react?.(seen, null);
}

describe('focusing the composer once the sheet is presented', () => {
  it('focuses once when the sheet reaches fully presented, not while it rises', () => {
    const progress = { value: 0 };
    const focus = vi.fn();
    mount(progress, focus);

    moveTo(progress, 0.4);
    moveTo(progress, 0.9);
    expect(focus).not.toHaveBeenCalled();

    moveTo(progress, 1);
    expect(focus).toHaveBeenCalledTimes(1);

    moveTo(progress, 1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not take the focus again when the sheet is dragged part-way and let go', () => {
    const progress = { value: 0 };
    const focus = vi.fn();
    mount(progress, focus);
    moveTo(progress, 1);

    moveTo(progress, 0.7);
    moveTo(progress, 1);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses again for the next present(), after the sheet has closed', () => {
    const progress = { value: 0 };
    const focus = vi.fn();
    mount(progress, focus);
    moveTo(progress, 1);

    moveTo(progress, 0);
    moveTo(progress, 1);

    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('leaves the focus alone where the chat is not in a sheet', () => {
    const focus = vi.fn();
    mount(undefined, focus);

    reaction.react?.(reaction.prepare?.() ?? 0, null);

    expect(focus).not.toHaveBeenCalled();
  });

  it('calls the latest focus, not the one from the render the reaction was made in', () => {
    const progress = { value: 0 };
    const first = vi.fn();
    const second = vi.fn();
    mount(progress, first);
    act(() => {
      renderer?.update(<Probe progress={progress} focus={second} />);
    });

    moveTo(progress, 1);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
