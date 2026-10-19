/**
 * A host with no app assertion (ADR 0021), for a suite's `@oxy.so/services/ui/client` mock.
 *
 * The SDK reads `useAppAssertion` from the same entry as `useOxy`, and no suite mounts an
 * `OxyProvider`, so a suite that reaches the stream or the call spreads this into its mock:
 * `...(await import('../support/app-assertion-host')).hostWithoutAppAssertion`. A suite about
 * the header returns its own `useAppAssertion`.
 */
export const hostWithoutAppAssertion = {
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
};
