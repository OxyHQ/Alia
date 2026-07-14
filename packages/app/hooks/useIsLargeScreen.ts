import { useWindowDimensions } from 'react-native';

/**
 * NativeWind's `md` breakpoint. Pure STYLING must use `md:` classes — reach for
 * this hook ONLY where logic branches on screen size (navigation props,
 * conditionally rendered trees, imperative handlers).
 */
export const MD_BREAKPOINT = 768;

export function useIsLargeScreen(): boolean {
  return useWindowDimensions().width >= MD_BREAKPOINT;
}
