import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How wide the right panel is, and why that is a number the reader owns.
 *
 * It was two constants: 320, or 420 when the panel held an agent. So how the
 * screen divides was decided once, by us, for everybody and every panel —
 * which #608 §5 asks to replace with the template's behaviour, where the panel
 * is dragged.
 *
 * The three properties below are the ones a drag can get wrong, and each of
 * them puts the panel somewhere the reader cannot get it back from:
 *
 * - **Clamping**, because the grip lives on the panel's inner edge. A panel
 *   dragged wider than the window takes its own handle off-screen with it, and
 *   there is then no way to drag it back.
 * - **Clamping on the way back IN**, because a width written by an older build
 *   or edited by hand is restored from storage without anyone dragging
 *   anything. `partialize` persists it; `merge` is what stops a stored 4000
 *   arriving intact.
 * - **Rounding**, because a pointer reports fractions and a layout given
 *   380.4px is a layout that re-measures on every frame of a drag.
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import {
  clampRightPanelWidth,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  useUIStore,
} from '@/features/chat/runtime/ui-store';

beforeEach(() => {
  useUIStore.setState({ rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH });
});

describe('clampRightPanelWidth', () => {
  it('keeps a width inside the range the layout can honour', () => {
    expect(clampRightPanelWidth(4000)).toBe(RIGHT_PANEL_MAX_WIDTH);
    expect(clampRightPanelWidth(10)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(-500)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('leaves a width already inside it alone', () => {
    expect(clampRightPanelWidth(400)).toBe(400);
  });

  it('rounds, because a pointer reports fractions', () => {
    expect(clampRightPanelWidth(380.4)).toBe(380);
    expect(clampRightPanelWidth(380.6)).toBe(381);
  });

  it('falls back rather than propagating a non-number', () => {
    // A corrupted store value, or a drag against a layout that has not measured
    // yet. `NaN` would pass every comparison and reach the layout as a width.
    expect(clampRightPanelWidth(Number.NaN)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(clampRightPanelWidth(Number.POSITIVE_INFINITY)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });
});

describe('setRightPanelWidth', () => {
  it('clamps what a drag asks for', () => {
    useUIStore.getState().setRightPanelWidth(9999);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MAX_WIDTH);

    useUIStore.getState().setRightPanelWidth(0);
    expect(useUIStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('accepts a width in range', () => {
    useUIStore.getState().setRightPanelWidth(420);
    expect(useUIStore.getState().rightPanelWidth).toBe(420);
  });
});

describe('one width for every panel', () => {
  it('does not change when the panel changes what it holds', () => {
    // The old code swapped 320 for 420 on the agent panel. The drag is the
    // reader's statement about their screen; forgetting it because the panel
    // now holds something else would be a strange kind of memory.
    useUIStore.getState().setRightPanelWidth(500);

    useUIStore.getState().setRightPanel('agent');
    expect(useUIStore.getState().rightPanelWidth).toBe(500);

    useUIStore.getState().setRightPanel('canvas');
    expect(useUIStore.getState().rightPanelWidth).toBe(500);
  });
});
