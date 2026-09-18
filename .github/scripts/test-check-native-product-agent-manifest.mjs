/**
 * `check-native-product-agent-manifest.mjs` must still be able to FAIL.
 *
 * The gate reads three files by regular expression, and the whole class of
 * failure it is protecting against is a copy of the manifest quietly ageing.
 * A regex that stopped matching reports exactly what a repository in perfect
 * agreement reports — a clean pass — so the cases below break each copy in turn
 * against a fixture tree and demand a non-zero exit.
 *
 * The real script is spawned, not imported: the exit code is the interface CI
 * consumes, and a test that imported a function would not notice the day the
 * script stopped calling it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const GATE = resolve(REPO, 'scripts/check-native-product-agent-manifest.mjs');

const CONFIG = 'packages/api/src/config/native-product-agents.ts';
const WORKFLOW = '.github/workflows/bootstrap-native-product-agents.yml';
const DOC = 'docs/agents.md';

const workspace = mkdtempSync(join(tmpdir(), 'check-native-agents-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

const REAL = {
  [CONFIG]: readFileSync(join(REPO, CONFIG), 'utf8'),
  [WORKFLOW]: readFileSync(join(REPO, WORKFLOW), 'utf8'),
  [DOC]: readFileSync(join(REPO, DOC), 'utf8'),
};

/** A copy of the three real files, with `edits` applied as string replacements. */
function tree(name, edits = {}) {
  const root = join(workspace, name);
  for (const [path, contents] of Object.entries(REAL)) {
    let text = contents;
    for (const [from, to] of edits[path] ?? []) {
      if (!text.includes(from)) {
        console.error(`FIXTURE ${name}: ${path} does not contain ${JSON.stringify(from)}`);
        process.exit(1);
      }
      text = text.replaceAll(from, to);
    }
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

let failures = 0;

function check(name, { root, status, contains = [] }) {
  const result = spawnSync('node', [GATE, root], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const problems = [];
  if (result.status !== status) {
    problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
  }
  for (const needle of contains) {
    if (!output.includes(needle)) problems.push(`said nothing about ${JSON.stringify(needle)}`);
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

// The positive control. Without it every case below is satisfied by a script
// that fails on everything.
check('the repository as it stands passes', { root: tree('clean'), status: 0 });

const SINDI_AGENT = '01a0646a-078f-7514-9800-9f43ceed7df8';
const SINDI_APP = '6a2f851751b784a86fd0e922';
const OTHER = '01a0646a-078f-7514-9800-000000000000';

check('an agent id changed in the config alone fails', {
  root: tree('config-drift', { [CONFIG]: [[SINDI_AGENT, OTHER]] }),
  status: 1,
  contains: ['hash'],
});

check('the workflow retargeted to another application fails', {
  root: tree('workflow-drift', { [WORKFLOW]: [[SINDI_APP, '6a2f851751b784a86fd0e000']] }),
  status: 1,
  contains: ['EXPECTED_HOMIIO_APPLICATION_ID'],
});

check('the documented table falling behind fails', {
  root: tree('doc-drift', { [DOC]: [[SINDI_AGENT, OTHER]] }),
  status: 1,
  contains: ['docs/agents.md'],
});

check('a hand-edited hash that no longer matches the values fails', {
  root: tree('hash-drift', {
    [CONFIG]: [[
      '4d8b711602fff69d9711202cfa6017090d0559b608fa7ed0e2e2b3c09cd2e4c6',
      '0000000000000000000000000000000000000000000000000000000000000000',
    ]],
  }),
  status: 1,
  contains: ['nativeProductAgents.test.ts'],
});

// The vacuity floor the gate declares for itself: a config it can no longer
// parse must be RED, not a clean pass over nothing.
check('a config the gate cannot parse fails rather than passing vacuously', {
  root: tree('unparseable', { [CONFIG]: [['      oxyAccountId:', '      oxyAccount:']] }),
  status: 1,
  contains: ['expected 2'],
});

if (failures > 0) {
  console.error(
    `\ncheck-native-product-agent-manifest is not doing its job: ${String(failures)} case(s) failed.`,
  );
  process.exit(1);
}

console.log('\ncheck-native-product-agent-manifest can still fail: every case behaved as demanded.');
