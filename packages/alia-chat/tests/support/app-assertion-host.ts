import { vi } from 'vitest';

/**
 * The host's `OxyProvider` app assertion (ADR 0021), for every suite.
 *
 * `@oxy.so/services/ui` is the real package entry the SDK reads
 * `useAppAssertion` from; no suite mounts an `OxyProvider`, so each would
 * otherwise load the whole entry for a hook it cannot use. This is a host with
 * no assertion. A suite about the header mocks the entry itself.
 */
vi.mock('@oxy.so/services/ui', () => ({
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
}));
