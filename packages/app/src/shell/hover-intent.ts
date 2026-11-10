import { useCallback, useEffect, useRef } from 'react';

/** How long the pointer must rest on a row before the work it would start is worth doing. */
export const HOVER_INTENT_MS = 150;

/**
 * Run `task` once the pointer has stopped moving across rows, not as it crosses them.
 *
 * A row's hover starts a fetch ahead of the press, and sweeping the pointer down a list used to
 * start one for every row it passed: dozens of requests a second, enough for the API's rate limit
 * to refuse the very conversations and agents the person then opened. One slot is pending at a
 * time and each new row replaces it, so a sweep ends in a single fetch for the row it rests on.
 */
export function useHoverIntent(delay: number = HOVER_INTENT_MS): (task: () => void) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (task) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        task();
      }, delay);
    },
    [delay],
  );
}
