import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The app's `@/*` path alias, which is declared in `tsconfig.json` and was
 * therefore invisible to vitest: it resolves module specifiers itself and reads
 * no tsconfig `paths`. Every test so far avoided the gap by `vi.mock()`ing each
 * `@/…` specifier a component imports — which intercepts BEFORE resolution — so
 * the first test to let one through resolved a real import and failed with
 * `Cannot find package '@/…'`.
 *
 * One alias, matching `tsconfig.json`, rather than a mock per import: mocking a
 * module only to make it resolvable replaces the code under test with a
 * re-implementation, and a test of a re-implementation measures nothing.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  /**
   * `__DEV__` is injected by Metro, not by the bundler vitest runs, and
   * `lib/config.ts` reads it at MODULE LOAD — so importing it from a test threw
   * a `ReferenceError` before the test body ever ran. `false` is what a
   * production bundle substitutes, which is the environment a test asserting
   * real URLs wants.
   */
  define: {
    __DEV__: 'false',
  },
});
