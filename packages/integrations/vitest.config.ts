import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * One throwaway, fully-migrated Postgres database per suite run. The suite
     * runs against a real server on purpose — see the setup file.
     */
    globalSetup: ['./vitest.pg.globalSetup.ts'],
    include: ['src/**/*.test.ts'],
    /**
     * Migrating a fresh database is a few seconds on a cold container, and the
     * default 5s timeout makes that read as a flaky test rather than a slow one.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
