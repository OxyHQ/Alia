/**
 * Every static asset a source file names must exist on disk.
 *
 * `require('@/assets/images/agent-avatar-reference.png')` is typed `any` by
 * TypeScript, which never resolves the path — so a source file naming an image
 * that has been deleted passes `Frontend Typecheck`, passes every test suite,
 * and fails in Metro at runtime. It is the same defect
 * `check-dockerfile-workspaces.mjs` exists for, one layer up: a reference and
 * the file it references are one fact, and splitting them across two changes
 * leaves a window in which the repository is green and the app is broken.
 *
 * That window opened here for real. The agent avatar's PNGs were deleted in one
 * pull request and the last `require` of them removed in another; the two
 * happened to land in the safe order, which is not a property anybody arranged.
 *
 * ## Discovered by walking, and by a pattern that is checked
 *
 * The files are walked rather than listed, for the reason the Dockerfile gate
 * records: a check that names its subject cannot see the subject nobody thought
 * to name.
 *
 * The pattern gets the same suspicion. The first version of this scan was
 * written with `grep -E` and a backreference to match the quote — which `-E`
 * does not support, so it silently matched NOTHING and reported a clean sweep
 * over the five references that were there. That is why the guard below fails
 * when the pattern stops matching, rather than congratulating itself on zero
 * problems in zero files.
 *
 * ## What it does not do
 *
 * It resolves `@/…` (the app's alias for its own root) and relative paths, and
 * skips anything else — a bare package specifier is a dependency, and whether
 * one is installed is `bun install`'s business, not this file's.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Walked, not listed — see the header. */
const SKIP = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '.expo', 'coverage', 'ios', 'android']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * The extensions that name a FILE rather than a module.
 *
 * Deliberately not `.json`: a `require` of one resolves through the module
 * graph like any other import, and Metro will fail the build over it.
 */
const ASSET = String.raw`png|jpe?g|webp|gif|svg|avif|ttf|otf|woff2?|mp3|wav|m4a|aac|mp4|lottie`;

/** `require('…')` and `from '…'`, for a path ending in one of those. */
const REFERENCES = new RegExp(
  String.raw`(?:require\(\s*|from\s*)(['"])([^'"]+\.(?:${ASSET}))\1`,
  'g'
);

/** Where `@/` points, per package that declares it. Only the app does today. */
const ALIAS_ROOTS = new Map([[join(root, 'packages/app'), join(root, 'packages/app')]]);

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      found.push(...sourceFiles(join(dir, entry.name)));
    } else if (SOURCE.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** The file a specifier names, or `null` when it is not this repository's to resolve. */
function resolveAsset(specifier, fromFile) {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  if (specifier.startsWith('@/')) {
    for (const [packageDir, aliasRoot] of ALIAS_ROOTS) {
      if (fromFile.startsWith(packageDir + '/')) return join(aliasRoot, specifier.slice(2));
    }
  }
  return null;
}

const files = sourceFiles(join(root, 'packages'));

if (files.length === 0) {
  console.error('check-static-assets: found no source files under packages/.');
  console.error('  The walk stopped matching, so this gate is measuring nothing.');
  process.exit(1);
}

const referenced = [];
for (const file of files) {
  for (const match of readFileSync(file, 'utf8').matchAll(REFERENCES)) {
    const target = resolveAsset(match[2], file);
    if (target !== null) {
      referenced.push({ file: relative(root, file), specifier: match[2], target });
    }
  }
}

if (referenced.length === 0) {
  console.error('check-static-assets: matched no asset references in any source file.');
  console.error('  The pattern stopped matching, so this gate is measuring nothing —');
  console.error('  which is exactly how its first version reported a clean sweep.');
  process.exit(1);
}

const missing = referenced.filter((reference) => !existsSync(reference.target));

if (missing.length > 0) {
  console.error('check-static-assets: a source file names an asset that is not on disk.');
  console.error('');
  for (const reference of missing) {
    console.error(`  ${reference.file} requires ${reference.specifier}, which does not exist.`);
  }
  console.error('');
  console.error('  Restore the file, or remove the reference. Metro fails on this at runtime;');
  console.error('  `tsc` types these as `any` and never resolves them, so nothing else does.');
  process.exit(1);
}

console.log(
  `check-static-assets: OK — ${String(referenced.length)} asset references across ` +
    `${String(files.length)} source files, every one resolves.`
);
