import { defineConfig } from 'tsup';

/**
 * Dual output on purpose. Consumers of this package are backends, and a good
 * number of them are still CommonJS — Homiio's Express API is `"type":
 * "commonjs"` under `ts-node`. A package that shipped ESM only, or raw
 * TypeScript the way `@alia.onl/sdk` does for Metro, would be unusable there.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
