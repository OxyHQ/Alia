/**
 * `scripts/check-ts-directives.mjs` must still be able to FAIL.
 *
 * Its job is to report nothing on this repository, which is also what it would
 * report if it stopped reading comments, read the wrong files or matched
 * nothing. So it runs here against trees built to break it, one per shape a
 * directive can take, plus the shapes it must leave alone. Each case states the
 * exit code it demands and what the output must name, because "it exited 1" is
 * satisfied by a crash.
 *
 * The REAL script, spawned the way CI spawns it. The gate lists files with
 * `git ls-files`, so every tree is a git repository with its files staged.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-ts-directives.mjs',
);

const workspace = mkdtempSync(join(tmpdir(), 'check-ts-directives-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

// Built from parts so that this file holds no directive of its own.
const NOCHECK = ['@ts', 'nocheck'].join('-');
const EXPECT = ['@ts', 'expect-error'].join('-');

/** A staged git tree under a fresh directory. `files` maps a path to its contents. */
function tree(name, files) {
  const root = join(workspace, name);
  mkdirSync(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  for (const command of [
    ['init', '-q'],
    ['add', '-A'],
  ]) {
    const result = spawnSync('git', command, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${command.join(' ')}: ${result.stderr}`);
  }
  return root;
}

let failures = 0;

function check(name, { root, status, contains = [], absent = [] }) {
  const result = spawnSync('node', [GATE, '--root', root], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const problems = [];
  if (result.status !== status) {
    problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
  }
  for (const needle of contains) {
    if (!output.includes(needle)) problems.push(`said nothing about ${JSON.stringify(needle)}`);
  }
  for (const needle of absent) {
    if (output.includes(needle)) problems.push(`named ${JSON.stringify(needle)}, which is allowed`);
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        output: ${output.trim().split('\n').join(' | ')}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

check('described expect-errors, strings and prose pass', {
  root: tree('clean', {
    'a.ts': [
      `// ${EXPECT} -- the upstream type omits this overload`,
      'const a: number = f();',
      `/* ${EXPECT}: the fixture is deliberately the wrong shape */`,
      'const b: number = g();',
      `const s = '// ${NOCHECK}';`,
      `const t = \`/* ${EXPECT} */\`;`,
      `// A comment that mentions ${NOCHECK} mid-sentence is prose, not a directive.`,
      'const r = /\\/\\/ @ts-/;',
    ].join('\n'),
  }),
  status: 0,
  contains: ['1 JS/TS files examined', '2 directive comment(s)', 'clean'],
});

check('a line-comment no-check fails, naming the file and line', {
  root: tree('nocheck-line', { 'src/x.ts': `// ${NOCHECK}\nexport const x = 1;\n` }),
  status: 1,
  contains: ['src/x.ts:1', '@ts-nocheck'],
});

check('a block-comment no-check fails', {
  root: tree('nocheck-block', { 'x.mjs': `/* ${NOCHECK} */\nexport const x = 1;\n` }),
  status: 1,
  contains: ['x.mjs:1', '@ts-nocheck'],
});

check('a no-check inside a JSDoc block fails, on its own line', {
  root: tree('nocheck-jsdoc', {
    'x.js': `/**\n * Legacy module.\n * ${NOCHECK}\n */\nexport const x = 1;\n`,
  }),
  status: 1,
  contains: ['x.js:3'],
});

check('a bare expect-error fails', {
  root: tree('expect-bare', { 'x.ts': `const a = 1;\n// ${EXPECT}\nconst b: number = '';\n` }),
  status: 1,
  contains: ['x.ts:2', '@ts-expect-error needs a description'],
});

check('a token description is not a description', {
  root: tree('expect-short', { 'x.ts': `// ${EXPECT}: x\nconst b: number = '';\n` }),
  status: 1,
  contains: ['x.ts:1'],
});

check('a bare expect-error inside JSX fails', {
  root: tree('expect-jsx', {
    'x.tsx': `export const X = () => (\n  <div>\n    {/* ${EXPECT} */}\n    <Y nope />\n  </div>\n);\n`,
  }),
  status: 1,
  contains: ['x.tsx:3'],
});

check('a trailing bare expect-error fails', {
  root: tree('expect-trailing', { 'x.cts': `const b: number = ''; // ${EXPECT}\n` }),
  status: 1,
  contains: ['x.cts:1'],
});

check('every violation is reported, not just the first', {
  root: tree('several', {
    'a.ts': `// ${NOCHECK}\n`,
    'b.tsx': `// ${EXPECT}\nconst b = 1;\n`,
  }),
  status: 1,
  contains: ['a.ts:1', 'b.tsx:1'],
});

check('an untracked file is outside the census', {
  root: (() => {
    const root = tree('untracked', { 'tracked.ts': 'export const ok = 1;\n' });
    writeFileSync(join(root, 'scratch.ts'), `// ${NOCHECK}\n`);
    return root;
  })(),
  status: 0,
  absent: ['scratch.ts'],
});

check('a tree with no JS/TS files refuses to report clean', {
  root: tree('empty', { 'README.md': `// ${NOCHECK}\n` }),
  status: 1,
  contains: ['no files to examine'],
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed: check-ts-directives.mjs can no longer be trusted.`);
  process.exit(1);
}
console.log('\ncheck-ts-directives.mjs still fails where it must.');
