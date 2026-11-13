import { type ComponentType, lazy, type LazyExoticComponent, useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * A component that lives in its own chunk, behind `React.lazy`, and can be fetched before it is
 * first rendered: `preload()` starts the same `import()` the lazy component will await, once.
 *
 * For surfaces that open on demand (a dialog, a panel) and that no first paint needs: they stay
 * out of the bundle every route loads, and `usePreloadWhenIdle` fetches them once the page has
 * settled, so the first open does not wait on the network either.
 */
export type Preloadable<P extends object> = LazyExoticComponent<ComponentType<P>> & {
  preload: () => Promise<unknown>;
};

export function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
): Preloadable<P> {
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  const preload = () => {
    pending ??= load().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        // Forget a failed fetch (offline, a deploy replaced the chunk), so the next render or
        // preload asks again instead of replaying the failure.
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  return Object.assign(lazy(preload), { preload });
}

/** Long enough for the first paint and its own requests to go first. */
const IDLE_TIMEOUT_MS = 4000;

/**
 * Fetches a `preloadable` component when the browser is idle after mount. Web only: a native
 * bundle has every module on the device, so there is nothing to fetch ahead of time.
 */
export function usePreloadWhenIdle(component: { preload: () => Promise<unknown> }) {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const preload = () => {
      // Ahead of time only: a failure is forgotten, and the first render fetches it again.
      component.preload().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = setTimeout(preload, IDLE_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [component]);
}
