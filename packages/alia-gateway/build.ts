import * as esbuild from 'esbuild';

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
      build.onResolve({ filter: /^@oxyhq\// }, () => undefined);
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

console.log('Build complete');
