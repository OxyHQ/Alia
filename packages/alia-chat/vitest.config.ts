import { defineConfig } from 'vitest/config';

/**
 * Bloom, and the packages Bloom's own modules reach for, are processed by vite rather than handed
 * to node: node resolves Bloom's `react-native` export condition to its raw `src/*.ts`, which the
 * runner will not parse. Inlined, a suite can mount the real Bloom component (the composer's key
 * rules are Bloom's, and `AliaComposer.keys.test.tsx` proves them against the real panel).
 * `react-native-css` publishes extensionless relative ESM, which a bundler resolves and node does
 * not; Bloom's styled components import it.
 */
export default defineConfig({
  test: {
    // The host's app assertion, which no suite has an `OxyProvider` for (`tests/support/app-assertion-host.ts`).
    setupFiles: ['./tests/support/app-assertion-host.ts'],
    server: {
      deps: {
        inline: [/@oxy\.so[\\/]bloom/, /react-native-css/],
      },
    },
  },
});
