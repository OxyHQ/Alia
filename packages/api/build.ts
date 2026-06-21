import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  // Keep node_modules external except @oxyhq/* (their ESM builds have broken imports)
  plugins: [{
    name: 'externalize-except-oxyhq',
    setup(build) {
      // Let @oxyhq/* packages be bundled (their ESM has missing .js extensions)
      build.onResolve({ filter: /^@oxyhq\// }, () => undefined);
      // Externalize all other bare imports (node_modules)
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@oxyhq/')) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
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
