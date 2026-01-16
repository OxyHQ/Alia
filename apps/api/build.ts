import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  packages: 'external', // Don't bundle node_modules
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('✅ Build complete');
