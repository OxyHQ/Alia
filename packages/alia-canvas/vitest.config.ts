import { defineConfig } from 'vitest/config';

/**
 * Canvas's suite, deliberately separate from `vite.config.ts`.
 *
 * Loading the app's vite config would mount the React plugin and a dev server
 * for a suite that needs neither — the same reason `alia-console` keeps its own
 * config. `include` is explicit so the runner cannot walk into `dist/` after a
 * build and execute a stale bundled copy of the code under test.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
