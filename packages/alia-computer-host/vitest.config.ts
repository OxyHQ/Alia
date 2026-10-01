import { defineConfig } from 'vitest/config';

/**
 * `include` is explicit so the runner cannot wander into `dist/` after a build
 * and execute a stale compiled copy of the code under test.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
