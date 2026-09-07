import { defineConfig } from 'vitest/config';

/**
 * The docker host's suite.
 *
 * `include` is explicit so the runner cannot wander into `dist/` after a
 * `bun run build` and execute a stale compiled copy of the code under test.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
