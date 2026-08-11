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
     * The Postgres suite has its own config (`vitest.pg.config.ts`, run by
     * `test:pg`) and its own CI job — **`api-postgres`**, `ci.yml:151`, which
     * stands up a `postgres:17-alpine` service. It needs a real server over TCP,
     * which this one does not. Excluded here so `bun run test` still works on a
     * machine without Docker.
     *
     * The job is NAMED because the previous wording — "its own CI job", with no
     * name — reads as a claim rather than a citation, and cost two rounds of
     * argument over whether the `*.pgdb.test.ts` files run in CI at all. They
     * do. A reader who doubts it can check the named job instead of grepping for
     * `test:pg` and trusting whatever tree they happen to be standing in.
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
