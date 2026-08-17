import { defineConfig } from 'vitest/config';

/**
 * The console's test config, deliberately separate from `vite.config.ts`.
 *
 * Without this file vitest loads the application's vite config, which mounts the
 * TanStack Start plugin and a dev server. The suite then passes and the process
 * sits for a further ten seconds before printing "something prevents Vite server
 * from exiting" — measured at 14s total against 3s here. In CI that is ten
 * seconds of every run spent shutting down a server no test asked for.
 *
 * The suite is a source census: it reads files off disk and parses them. It
 * needs no DOM, no bundler and no plugins, so it is given none.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
