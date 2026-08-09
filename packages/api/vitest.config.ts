import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@oxyhq/core/server': fileURLToPath(new URL('./src/__tests__/mocks/oxy-core-server.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * The Postgres suite has its own config and its own CI job — it needs a real
     * server over TCP, which this one does not. Excluded here so `bun run test`
     * still works on a machine without Docker.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.pgdb.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    globalSetup: [fileURLToPath(new URL('./vitest.globalSetup.ts', import.meta.url))],
    // The replica set takes a while to come up on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
