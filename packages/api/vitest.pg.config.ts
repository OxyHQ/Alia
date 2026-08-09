import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Postgres half of this package's suite, run separately from the default
 * config.
 *
 * Two configs rather than one with both global setups, because they have
 * different PREREQUISITES: the default suite needs only an in-process MongoDB
 * replica set (`mongodb-memory-server` downloads its own binary), while this one
 * needs a real Postgres server reachable over TCP. Merging them would make every
 * `bun run test` — and the existing CI job — fail on a machine without Docker,
 * which is a good way to get a suite disabled by whoever hits it next.
 *
 * `*.pgdb.test.ts` rather than the Mongo suite's `*-real-db.test.ts`: both are
 * "real database" tests and only the file name says which database, so the two
 * names have to be tellable apart at a glance.
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   TEST_DATABASE_URL=postgres://alia:alia@127.0.0.1:5438/postgres bun run test:pg
 */
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest.pg.globalSetup.ts', import.meta.url))],
    include: ['src/**/*.pgdb.test.ts'],
    /**
     * Migrating a fresh database is a few seconds on a cold container, and the
     * default 5s timeout makes that read as a flaky test rather than a slow one.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
