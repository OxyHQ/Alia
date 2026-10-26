import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/lib/voice/__tests__/*.redis.test.ts'],
    exclude: [],
    fileParallelism: false,
  },
});
