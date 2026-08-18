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
    /**
     * There is no `globalSetup` here any more, and its removal is a deletion of
     * dead work rather than a loosening. It stood up a `mongodb-memory-server`
     * replica set on every run and published the URI as `ALIA_TEST_MONGODB_URI`,
     * which **no test ever read** — the Mongo suites that needed it were deleted
     * with their domains during the Postgres port, and the setup outlived them.
     * Every run paid a mongod binary download and a replica-set election for a
     * variable with zero consumers.
     *
     * `vitest.pg.globalSetup.ts` is the one that survives, on the other config.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
