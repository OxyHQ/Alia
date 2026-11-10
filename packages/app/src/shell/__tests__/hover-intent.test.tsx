import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_INTENT_MS, useHoverIntent } from '@/shell/hover-intent';

/** Hovering rows runs one task for the row the pointer rests on, never one per row it crosses. */

function mount() {
  let intent!: (task: () => void) => void;
  const Probe = () => {
    intent = useHoverIntent();
    return null;
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe />);
  });
  return { hover: (task: () => void) => act(() => intent(task)), renderer };
}

describe('useHoverIntent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs nothing while the pointer crosses rows, then one task for the row it rests on', () => {
    const { hover } = mount();
    const tasks = [vi.fn(), vi.fn(), vi.fn()];
    for (const task of tasks) {
      hover(task);
      act(() => {
        vi.advanceTimersByTime(HOVER_INTENT_MS - 50);
      });
    }
    expect(tasks.map((t) => t.mock.calls.length)).toEqual([0, 0, 0]);
    act(() => {
      vi.advanceTimersByTime(HOVER_INTENT_MS);
    });
    expect(tasks.map((t) => t.mock.calls.length)).toEqual([0, 0, 1]);
  });

  it('runs nothing once the list is gone', () => {
    const { hover, renderer } = mount();
    const task = vi.fn();
    hover(task);
    act(() => renderer.unmount());
    act(() => {
      vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
    });
    expect(task).not.toHaveBeenCalled();
  });
});
