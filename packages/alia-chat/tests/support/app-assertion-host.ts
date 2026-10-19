import { vi } from 'vitest';

/**
 * The host's `OxyProvider` app assertion (ADR 0021), for every suite.
 *
 * The SDK reads `useAppAssertion` from `@oxy.so/services/ui/client`; no suite
 * mounts an `OxyProvider`, so this is a host with no assertion, over the real
 * entry. A suite that mocks `ui/client` itself replaces all of it, so it gives
 * `useAppAssertion` too when what it mounts sends a request.
 */
vi.mock('@oxy.so/services/ui/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
}));
