#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `--root <dir>` points the gate at a tree other than this repository.
 *
 * Only `test-check-no-mongodb-runtime.mjs` passes it, and it is why that file
 * can exist: a gate whose subject is hard-coded to the repository it lives in
 * can only be observed passing, and "it passed" and "it stopped looking" are
 * the same observation. Same handle, same reason, as `check-static-assets.mjs`.
 */
const rootFlag = process.argv.indexOf('--root');
const root = rootFlag === -1
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : path.resolve(process.argv[rootFlag + 1] ?? '.');
const consoleOutput = path.join(root, 'packages/alia-console/.output');
const failures = [];

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

/**
 * Every tracked workspace manifest, INCLUDING the nested ones.
 *
 * This was `^packages/[^/]+/package\.json$`, which cannot see
 * `packages/alia-codea/webview-ui` or `packages/alia-cowork/renderer` — two
 * real workspaces, one of them declared in the root `workspaces` array. A
 * Mongo dependency added to either passed this gate.
 *
 * `scripts/check-model-defaults.mjs` already enumerates both, so the
 * repository disagreed with itself about which trees exist.
 */
const MANIFEST = /^packages\/(?:[^/]+\/)+package\.json$/;

/**
 * Every tracked source file under `packages/`, wherever it lives in its
 * workspace.
 *
 * This was `^packages/[^/]+/src/…`, which assumes every workspace keeps its
 * code in `src/`. **`packages/app` has no `src/` directory at all**, so all
 * 376 of its tracked sources — the largest client in the repository — were
 * invisible to this gate, along with `alia-cowork/renderer` and
 * `alia-codea/webview-ui`. Measured on the tree that introduced this comment:
 * 1 009 of 1 539 files were being scanned.
 *
 * `docs/mongodb-runtime-boundary.md` says the gate "fails if any workspace
 * adds a direct Mongo dependency [or] runtime source imports a Mongo driver".
 * That is now what it does.
 */
const SOURCE = /^packages\/.+\.(?:[cm]?[jt]sx?)$/;

/**
 * Generated or vendored trees that are not anybody's runtime source.
 *
 * `.output` is Nitro's build directory for `alia-console`, and it is checked
 * further down as a BUILT ARTEFACT — by a stricter test that also looks for
 * driver fingerprints rather than only for imports. Letting it match here as
 * well would double-report it, and would count emitted files toward the
 * "matched no source files" floor, which is supposed to notice that the SOURCE
 * pattern stopped matching.
 */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|build|out|\.output|\.expo|coverage)\//;

const manifests = tracked.filter((file) => MANIFEST.test(file));
// A vacuity floor, recorded as a FAILURE rather than an early exit. Exiting
// here would let a pattern that stopped matching mask a real finding in the
// other half of the gate — the same "green for the wrong reason" this floor
// exists to prevent, one level up.
if (manifests.length === 0) {
  failures.push('matched no workspace manifests at all — the pattern stopped matching');
}

for (const relative of manifests) {
  const manifest = JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (dependency === 'mongodb' || dependency === 'mongoose' || dependency.startsWith('@mongodb-js/')) {
        failures.push(`${relative}: direct ${section}.${dependency}`);
      }
    }
  }
}

const runtimeImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:mongodb|mongoose|@mongodb-js\/)/;
const sources = tracked.filter((file) =>
  SOURCE.test(file)
  && !NOT_SOURCE.test(file)
  && !file.includes('/__tests__/')
  && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
);
// The other vacuity floor, additive for the same reason.
if (sources.length === 0) {
  failures.push('matched no source files at all — the pattern stopped matching');
}

for (const relative of sources) {
  if (runtimeImport.test(readFileSync(path.join(root, relative), 'utf8'))) {
    failures.push(`${relative}: imports a Mongo runtime`);
  }
}

if (!existsSync(path.join(consoleOutput, 'server/index.mjs'))) {
  failures.push('packages/alia-console/.output/server/index.mjs is absent; build alia-console before this gate');
} else {
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!/\.(?:m?js|cjs|json)$/.test(entry)) continue;
      const source = readFileSync(absolute, 'utf8');
      if (
        runtimeImport.test(source)
        || /mongodb-connection-string-url|@mongodb-js\/saslprep|node_modules\/mongodb/.test(source)
      ) {
        failures.push(`${path.relative(root, absolute)}: built Mongo runtime fingerprint`);
      }
    }
  };
  visit(consoleOutput);
}

if (failures.length > 0) {
  console.error(`Mongo runtime boundary failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log(
  'Mongo runtime boundary passed: '
    + `${String(manifests.length)} workspace manifests and ${String(sources.length)} source files `
    + 'carry no direct dependency or import, and the alia-console build artefact contains no driver.',
);
