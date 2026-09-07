/**
 * `check-no-mongodb-runtime.mjs` must still be able to FAIL.
 *
 * ## Why this file exists
 *
 * `docs/mongodb-runtime-boundary.md` says the gate "fails if any workspace adds
 * a direct Mongo dependency, runtime source imports a Mongo driver, the console
 * was not built, or its emitted JS/JSON contains a Mongo import/driver
 * fingerprint". That is a claim about a script that, until now, had only ever
 * been observed passing — and a gate that has stopped looking passes exactly
 * the way a clean repository does.
 *
 * It HAD stopped looking, over most of the tree. Its manifest pattern was
 * `^packages/[^/]+/package.json$`, which cannot see the two nested workspaces,
 * and its source pattern was `^packages/[^/]+/src/…`, which assumes every
 * workspace keeps its code in `src/`. `packages/app` has no `src/` directory,
 * so the largest client in the repository — 376 tracked files — was outside the
 * gate entirely. Measured before the fix: 1 009 of 1 539 files scanned. Nothing
 * was red, because nothing was being read.
 *
 * The two cases named `the case the old pattern missed` are that defect,
 * frozen. They fail against the pre-fix script and pass against this one.
 *
 * ## Why fixtures are real git repositories
 *
 * The gate reads `git ls-files`, deliberately: an untracked file ships to
 * nobody, so scanning one would produce failures no deploy could suffer from.
 * A fixture that faked the file list would be testing a different script.
 *
 * Deliberately the REAL script, spawned the way CI spawns it, rather than its
 * internals imported: the exit code is the interface, and a test that imported
 * a function would not notice the day the script stopped calling it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-no-mongodb-runtime.mjs',
);

const workspace = mkdtempSync(join(tmpdir(), 'check-no-mongo-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

/** A clean console build artefact, so cases can fail for the reason they name. */
const BUILT_CONSOLE = {
  'packages/alia-console/.output/server/index.mjs': 'export default {};\n',
};

/** Build a tracked tree under a fresh directory. `files` maps a path to contents. */
function tree(name, files) {
  const root = join(workspace, name);
  mkdirSync(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  // `git ls-files` is the gate's source of truth, so the fixture has to be a
  // repository with the files actually staged.
  const git = (...args) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'gate');
  git('add', '-A', '-f');
  return root;
}

function run(root) {
  const result = spawnSync('node', [GATE, '--root', root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let failures = 0;

function check(name, { root, status, contains }) {
  const result = run(root);
  const problems = [];
  if (result.status !== status) {
    problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
  }
  for (const needle of contains) {
    if (!result.output.includes(needle)) problems.push(`said nothing about ${JSON.stringify(needle)}`);
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        output: ${result.output.trim().split('\n').join(' | ')}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

// ── The positive control ────────────────────────────────────────────────────
// Without this, every case below could be satisfied by a script that fails on
// everything.
check('a clean tree passes', {
  root: tree('clean', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': JSON.stringify({ dependencies: { pg: '^8' } }),
    'packages/api/src/index.ts': "import pg from 'pg';\n",
    'packages/app/lib/db.ts': "import { drizzle } from 'drizzle-orm';\n",
  }),
  status: 0,
  contains: ['Mongo runtime boundary passed'],
});

// ── What the documentation promises ─────────────────────────────────────────
check('a direct mongodb dependency fails', {
  root: tree('direct-dep', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': JSON.stringify({ dependencies: { mongodb: '^7' } }),
  }),
  status: 1,
  contains: ['dependencies.mongodb'],
});

check('a mongoose optionalDependency fails', {
  root: tree('optional-dep', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': JSON.stringify({ optionalDependencies: { mongoose: '^8' } }),
  }),
  status: 1,
  contains: ['optionalDependencies.mongoose'],
});

check('a source file importing a Mongo driver fails', {
  root: tree('import', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': '{}',
    'packages/api/src/db.ts': "import { MongoClient } from 'mongodb';\n",
  }),
  status: 1,
  contains: ['imports a Mongo runtime'],
});

check('an unbuilt console fails', {
  // Carries a manifest AND a source file, so the two vacuity floors are
  // satisfied and this case can only fail for the reason it names.
  root: tree('unbuilt', {
    'packages/api/package.json': '{}',
    'packages/api/src/index.ts': "import pg from 'pg';\n",
  }),
  status: 1,
  contains: ['build alia-console before this gate'],
});

check('a Mongo fingerprint in the built console fails', {
  root: tree('built-fingerprint', {
    'packages/alia-console/.output/server/index.mjs':
      "const x = require('node_modules/mongodb/lib/index.js');\n",
    'packages/api/package.json': '{}',
  }),
  status: 1,
  contains: ['built Mongo runtime fingerprint'],
});

// ── The case the old pattern missed ─────────────────────────────────────────
check('the case the old pattern missed: a nested workspace manifest', {
  root: tree('nested-manifest', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': '{}',
    // A real workspace: `packages/alia-codea/webview-ui` is in the root
    // `workspaces` array, and `^packages/[^/]+/package.json$` cannot see it.
    'packages/alia-codea/webview-ui/package.json': JSON.stringify({
      dependencies: { mongoose: '^8' },
    }),
  }),
  status: 1,
  contains: ['dependencies.mongoose'],
});

check('the case the old pattern missed: source outside a src/ directory', {
  root: tree('no-src-dir', {
    ...BUILT_CONSOLE,
    'packages/api/package.json': '{}',
    // `packages/app` keeps its code in `app/`, `lib/` and `components/`; it has
    // no `src/` at all, so `^packages/[^/]+/src/…` saw none of it.
    'packages/app/lib/store.ts': "import mongoose from 'mongoose';\n",
  }),
  status: 1,
  contains: ['imports a Mongo runtime'],
});

// ── The vacuity floors the gate declares for itself ─────────────────────────
// Both branches exist so a pattern that stops matching turns the gate RED
// rather than green. Asserted, because a self-check nobody exercises is the
// same silent no-op it was written to prevent.
check('a tree with no workspace manifests fails rather than passing vacuously', {
  root: tree('no-manifests', { ...BUILT_CONSOLE, 'README.md': '# nothing here\n' }),
  status: 1,
  contains: ['matched no workspace manifests at all'],
});

check('a tree with no source files fails rather than passing vacuously', {
  root: tree('no-sources', { ...BUILT_CONSOLE, 'packages/api/package.json': '{}' }),
  status: 1,
  contains: ['matched no source files at all'],
});

if (failures > 0) {
  console.error(`\ncheck-no-mongodb-runtime is not doing its job: ${String(failures)} case(s) failed.`);
  process.exit(1);
}

console.log('\ncheck-no-mongodb-runtime can still fail: every case behaved as demanded.');
