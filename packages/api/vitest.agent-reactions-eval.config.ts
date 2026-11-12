import { defineConfig } from 'vitest/config';

// Real Oxy inference, synthetic conversation storage. Never alias the Oxy server client.
process.env.LOG_LEVEL = 'silent';
export default defineConfig({
  test: {
    include: ['src/lib/chat/reactions/__tests__/agent-participation.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 30_000,
  },
});
