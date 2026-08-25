/**
 * `check-static-assets.mjs` must still be able to FAIL.
 *
 * A gate is only worth its runtime if a broken tree turns it red, and the day
 * that stops being true is not the day anybody notices: it goes green, over and
 * over, and reads exactly like a repository with nothing wrong in it. The gate's
 * first version was already an instance — its pattern used a `grep -E`
 * backreference, matched nothing, and reported a clean sweep across five real
 * references.
 *
 * So its ability to fail is gated too, against trees built to be broken. Each
 * case states the exit code it demands and what the message must name, because
 * "it exited 1" is satisfied by a crash.
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

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/check-static-assets.mjs');

const workspace = mkdtempSync(join(tmpdir(), 'check-static-assets-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

/** Build a tree under a fresh directory. `files` maps a path to its contents. */
function tree(name, files) {
  const root = join(workspace, name);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
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
  if (result.status !== status) problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
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

/** Both resolution shapes the gate supports, both pointing at files that exist. */
check('a tree whose assets all exist passes', {
  root: tree('clean', {
    'packages/app/assets/images/logo.png': 'x',
    'packages/app/assets/sounds/ping.mp3': 'x',
    'packages/app/screen.tsx': `
      const logo = require('@/assets/images/logo.png');
      const ping = require('./assets/sounds/ping.mp3');
    `,
  }),
  status: 0,
  contains: ['OK', '2 asset references'],
});

check('an aliased asset that is gone fails, and is named', {
  root: tree('missing-alias', {
    'packages/app/assets/images/logo.png': 'x',
    'packages/app/screen.tsx': `
      const logo = require('@/assets/images/logo.png');
      const gone = require('@/assets/images/deleted.png');
    `,
  }),
  status: 1,
  contains: ['packages/app/screen.tsx', '@/assets/images/deleted.png', 'does not exist'],
});

check('a relative asset that is gone fails, and is named', {
  root: tree('missing-relative', {
    'packages/app/screen.tsx': `const gone = require('./assets/deleted.webp');`,
  }),
  status: 1,
  contains: ['./assets/deleted.webp'],
});

check('an ESM import of a missing asset fails too, not only require()', {
  root: tree('missing-import', {
    'packages/app/screen.tsx': `import logo from '@/assets/images/deleted.svg';`,
  }),
  status: 1,
  contains: ['@/assets/images/deleted.svg'],
});

check('a bare package specifier is somebody else’s problem, and passes', {
  root: tree('bare-specifier', {
    'packages/app/assets/images/logo.png': 'x',
    'packages/app/screen.tsx': `
      const theirs = require('some-package/logo.png');
      const ours = require('@/assets/images/logo.png');
    `,
  }),
  status: 0,
  contains: ['OK', '1 asset reference'],
});

/**
 * The two guards that make the difference between "nothing is broken" and
 * "nothing was looked at". Without these cases the gate could quietly stop
 * matching and keep printing OK, which is how its first version behaved.
 */
check('a tree with source files but no asset references fails, rather than passing over zero', {
  root: tree('no-references', {
    'packages/app/screen.tsx': `export const nothing = 1;`,
  }),
  status: 1,
  contains: ['matched no asset references', 'measuring nothing'],
});

check('a tree with no source files at all fails', {
  root: tree('no-sources', { 'packages/app/README.md': 'nothing to scan' }),
  status: 1,
  contains: ['no source files', 'measuring nothing'],
});

check('a root with no packages directory fails', {
  root: tree('no-packages', { 'README.md': 'not a repository' }),
  status: 1,
  contains: ['no packages directory', 'measuring nothing'],
});

if (failures > 0) {
  console.error(`\ncheck-static-assets is not behaving: ${String(failures)} case(s) failed.`);
  process.exit(1);
}

console.log('\ncheck-static-assets: every case behaved — it can still fail, and still passes.');
