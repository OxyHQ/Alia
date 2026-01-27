import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';
import { join } from 'path';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  // Keep all node_modules external - they'll be installed via npm install
  packages: 'external',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Copy prompts directory to dist
try {
  await cp('prompts', 'dist/prompts', { recursive: true });
  console.log('✅ Copied prompts to dist/');
} catch (error) {
  console.error('⚠️ Failed to copy prompts:', error);
}

console.log('✅ Build complete');
