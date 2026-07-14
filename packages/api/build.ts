import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';

// Keep node_modules external except @oxyhq/* (their ESM builds have broken imports).
const externalizeExceptOxyhq: esbuild.Plugin = {
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
};

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  plugins: [externalizeExceptOxyhq],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// One-shot operational scripts — bundled so they ship in the runtime image and
// can be run as a Fargate command override (e.g. the IP-purge migration).
await esbuild.build({
  entryPoints: ['src/scripts/purge-ip-fields.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/scripts/purge-ip-fields.js',
  plugins: [externalizeExceptOxyhq],
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
