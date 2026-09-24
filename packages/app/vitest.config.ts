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
   * Bloom, and the packages Bloom's own modules reach for, processed by vite
   * rather than handed to node.
   *
   * Without this NOTHING from `@oxy.so/bloom/*` could be imported in a test at
   * all: node resolves the package's `react-native` export condition to its raw
   * `src/*.ts`, which the runner will not parse, and the suite dies at import
   * with `Unexpected token 'typeof'`. That is why the older tests in this repo
   * mock every `@oxy.so/bloom/*` specifier instead of importing it — and a test
   * that mocks the component it is about is a test of its own stub.
   *
   * `react-native-css` is here for a different reason with the same effect: it
   * publishes extensionless relative ESM (`./runtime`), which a bundler
   * resolves and node does not. Bloom's styled components import it, so it is
   * reached by anything that mounts one.
   *
   * Inlining is what makes #608 testable rather than assertable: an adoption
   * can now be proven by mounting the real Bloom component, as the suites
   * under `components/__tests__` do.
   */
  test: {
    server: {
      deps: {
        inline: [/@oxy\.so[\\/]bloom/, /react-native-css/],
      },
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
