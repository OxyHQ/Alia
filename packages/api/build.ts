import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';

// Keep every node_modules dependency external, @oxyhq/* included.
//
// @oxyhq/* used to be exempted and bundled, on the rationale that its ESM
// builds omitted the .js extension on relative imports (which Node's ESM loader
// requires). Re-measured 2026-07-31 against @oxyhq/core 13.0.0 — the only
// @oxyhq/* dependency this package declares: 225 of 225 executable relative
// specifiers in dist/esm (99 files, incl. dist/esm/server) carry an extension,
// 0 are extensionless. Node imports '@oxyhq/core', '@oxyhq/core/server' and its
// transitive '@oxyhq/protocol' as ESM without complaint. The rationale is
// obsolete.
//
// The exemption was also actively dangerous. @oxyhq packages published as
// CommonJS (every @oxyhq/crowdsource* package today) get each internal
// require() rewritten into an esbuild shim when inlined into this ESM bundle,
// which throws the moment it runs:
//   Error: Dynamic require of "zod" is not supported
// That killed Moovo's backend at container start (2026-07-30) — tests,
// typecheck and image build were all green, because the failure is at startup.
// Node's own ESM loader imports CJS packages correctly, so leave the resolution
// to Node; the runtime image ships the hoisted node_modules for the
// externalized bundle to resolve against (see Dockerfile).
//
// What would invalidate this: an @oxyhq/* package entering this package's
// dependency graph whose ESM build DOES use extensionless relative imports.
// That is not hypothetical and the property is per-package, not ecosystem-wide
// — @oxyhq/bloom 0.67.0 measured 81 of 81 extensionless in lib/ on the same
// date. This package does not depend on it; if that ever changes, re-measure
// the ESM dist of the packages package.json actually declares rather than
// trusting the numbers above to still hold.
const externalizeNodeModules: esbuild.Plugin = {
  name: 'externalize-node-modules',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, external: true }));
  },
};

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  plugins: [externalizeNodeModules],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// The database migrator, bundled so it ships in the runtime image and can be run
// as a Fargate command override before the rollout.
//
// It MUST be an entrypoint of its own. The deploy's one-shot task invokes a file
// path, and a migrator that only exists as TypeScript source is a deploy step
// that cannot work — the runtime stage is `node:*-slim` and carries no bun and no
// `src/`. This is the half that fails silently: `RUN_MIGRATIONS` defaults to
// false, so nothing complains until the day somebody turns it on.
await esbuild.build({
  entryPoints: ['src/db/migrate.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/db/migrate.js',
  plugins: [externalizeNodeModules],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// The seeder, bundled for the same reason the migrator is: the deploy's
// post-rollout one-shot invokes a FILE PATH, and the runtime stage is
// `node:*-slim` with no bun and no `src/`. A seeder that exists only as
// TypeScript is a deploy step that cannot run — and this one fails the same way
// the migrator's entrypoint did: silently, because nothing complains until the
// day the command is actually issued. `db/__tests__/deployWorkflow.test.ts`
// asserts this outfile and the workflow's use of it together.
await esbuild.build({
  entryPoints: ['src/scripts/seed.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/scripts/seed.js',
  plugins: [externalizeNodeModules],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// The plan-model one-shot. `plans.model_ids` has a seeder that will not touch an existing row and
// an audited writer with no runtime caller, so correcting a stale list needs a
// command, and a command needs a bundle.
await esbuild.build({
  entryPoints: ['src/scripts/plan-models.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/scripts/plan-models.js',
  plugins: [externalizeNodeModules],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Read-only rollout gate: list active agent IDs that lack a reviewed exact Oxy
// routing-profile PK before ECS points at an image that refuses legacy arrays.
await esbuild.build({
  entryPoints: ['src/scripts/check-agent-routing-profile-readiness.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/scripts/check-agent-routing-profile-readiness.js',
  plugins: [externalizeNodeModules],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// The show-object purge. Same reason as every one-shot above, with one of its
// own: it is the S3 half of migration 0034, so it runs in the same window as
// that migration, against the same image, on a Fargate command override — and
// the migration's `post` phase is applied by a task that carries no `src/`.
await esbuild.build({
  entryPoints: ['src/scripts/purge-show-objects.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/scripts/purge-show-objects.js',
  plugins: [externalizeNodeModules],
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

/**
 * The built-in Agent Skills, beside the prompts and for the same reason.
 *
 * `lib/skills/seed.ts` resolves `<bundle>/../skills` at runtime, which is
 * `dist/skills` — the bundle is emitted to `dist/scripts/seed.js`. The
 * Dockerfile also copies `packages/api/skills`, but nothing reads THAT path
 * from inside the bundle: this copy is what puts the directory where the code
 * looks. Its absence cost a production deploy — the seed threw
 * `No built-in skills directory found`, the reconciliation task exited 1, and
 * ECS rolled the service back onto an image older than the migrations that had
 * already applied.
 */
try {
  await cp('skills', 'dist/skills', { recursive: true });
  console.log('✅ Copied skills to dist/');
} catch (error) {
  console.error('⚠️ Failed to copy skills:', error);
}

console.log('✅ Build complete');
