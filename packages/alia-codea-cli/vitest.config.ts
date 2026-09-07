import { defineConfig } from 'vitest/config';

/**
 * The CLI's suite. `include` is explicit rather than left to vitest's default
 * glob so the runner cannot wander into `dist/` after a `bun run build`, which
 * would run a stale bundled copy of the very code under test.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
