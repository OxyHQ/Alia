import { defineConfig } from 'vitest/config';

// Explicit opt-in: real Oxy inference, synthetic rooms, no actor tools or balance mutations.
// Unlike vitest.config.ts, this config MUST NOT alias OxyServer to the unit-test mock.
process.env.LOG_LEVEL = 'silent';

export default defineConfig({
  test: {
    include: ['src/lib/chat/room/__tests__/selection.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
});
