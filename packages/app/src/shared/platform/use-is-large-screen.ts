import { BREAKPOINTS } from '@oxy.so/bloom/styles';
import { useWindowWidthClass } from '@oxy.so/bloom/hooks';

/**
 * NativeWind's `md` breakpoint. Pure STYLING must use `md:` classes — reach for
 * this hook ONLY where logic branches on screen size (navigation props,
 * conditionally rendered trees, imperative handlers). Re-renders only when the
 * window crosses `md`, not on every pixel of a resize.
 */
const MD_THRESHOLDS = [BREAKPOINTS.md] as const;

export function useIsLargeScreen(): boolean {
  return useWindowWidthClass(MD_THRESHOLDS) >= BREAKPOINTS.md;
}
