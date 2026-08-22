import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Postgres half of this package's suite, run separately from the default
 * config.
 *
 * Two configs rather than one, because they have different PREREQUISITES: the
 * default suite needs nothing but a Node process, while this one needs a real
 * Postgres server reachable over TCP. Merging them would make every `bun run
 * test` — and the `Lint & Test` CI job — fail on a machine without Docker,
 * which is a good way to get a suite disabled by whoever hits it next.
 *
 * `*.pgdb.test.ts` names the database in the file name. The convention outlived
 * the Mongo suite it was invented to be tellable apart from, and it stays: the
 * default config EXCLUDES this glob, so a real-database test that loses the
 * suffix silently moves into a job with no Postgres.
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   TEST_DATABASE_URL=postgres://alia:alia@127.0.0.1:5440/postgres bun run test:pg
 *
 * The port is 5440 because that is what `docker-compose.postgres.yml` publishes.
 * It said 5438 here for a while, which is not a harmless typo: 5438 is a common
 * default and is already taken by another project's database on at least one
 * machine, so following this recipe pointed a 28-migration run at it. Only a
 * password mismatch stopped it. If you change the published port, change it
 * here in the same edit.
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
