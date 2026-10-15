import { useCallback, useRef } from 'react';
import {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useSharedValue,
} from 'react-native-reanimated';

/** Bloom's sheet reports `1` once fully presented; a hair under it absorbs float rounding. */
const PRESENTED = 0.999;

/**
 * Calls `focus` once each time a sheet finishes presenting.
 *
 * `progress` is the `animatedProgress` of Bloom's `BottomSheet`: `0` closed, `1` fully
 * presented, every value between while it animates or is dragged. The sheet is armed while it
 * is closed and fires on reaching `1`, so dragging it part-way and letting go does not take the
 * focus again; only a new `present()` does. Reduced motion settles immediately, which is the
 * same crossing. Omitted, nothing happens — the surface is not a sheet.
 */
export function useFocusWhenPresented(
  progress: SharedValue<number> | undefined,
  focus: () => void,
): void {
  const latest = useRef(focus);
  latest.current = focus;
  const run = useCallback(() => latest.current(), []);
  const armed = useSharedValue(true);
  useAnimatedReaction(
    () => progress?.value ?? 0,
    (value) => {
      if (value <= 0) {
        armed.value = true;
      } else if (value >= PRESENTED && armed.value) {
        armed.value = false;
        runOnJS(run)();
      }
    },
    [progress, run],
  );
}
