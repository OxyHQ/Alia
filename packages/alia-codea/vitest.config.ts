import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The real `vscode` module only exists inside the extension host; point it
      // at an in-repo stub for tests.
      vscode: path.resolve(process.cwd(), 'src/__tests__/vscode.mock.ts'),
    },
  },
});
