/**
 * `scripts/check-bun-pin.mjs` must still be able to FAIL.
 *
 * Same reasoning as test-check-static-assets.mjs: a gate that stopped matching
 * prints OK forever, and reads exactly like a repository where every image runs
 * the pinned bun. So it is pointed at trees built to be broken, and each case
 * states the exit code it demands and what the message must name, because
 * "it exited 1" is satisfied by a crash.
 *
 * The REAL script, spawned the way CI spawns it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/check-bun-pin.mjs');

const workspace = mkdtempSync(join(tmpdir(), 'check-bun-pin-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

const PIN = '1.4.3';

const SETUP_BUN = `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      - run: bun install --frozen-lockfile
`;

const OVEN_STAGE = `ARG BUN_VERSION=${PIN}
FROM oven/bun:\${BUN_VERSION}-slim AS builder
RUN bun install --frozen-lockfile
`;

const INSTALL_SCRIPT = `ARG BUN_VERSION=${PIN}
FROM node:22-bookworm-slim AS toolchain
ARG BUN_VERSION
RUN apt-get update && \\
    curl -fsSL https://bun.com/install -o /tmp/install-bun.sh && \\
    bash /tmp/install-bun.sh "bun-v\${BUN_VERSION}" && \\
    rm /tmp/install-bun.sh
FROM toolchain AS builder
RUN bun install --frozen-lockfile
`;

/** A repository that passes; each case overrides the files it breaks. */
function tree(name, overrides = {}) {
  const files = {
    'package.json': JSON.stringify({ packageManager: `bun@${PIN}` }),
    'packages/api/Dockerfile': OVEN_STAGE,
    'packages/integrations/Dockerfile': INSTALL_SCRIPT,
    '.github/workflows/ci.yml': SETUP_BUN,
    ...overrides,
  };
  const root = join(workspace, name);
  for (const [path, contents] of Object.entries(files)) {
    if (contents === null) continue;
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

let failures = 0;

function check(name, { root, status, contains }) {
  const result = spawnSync('node', [GATE, '--root', root], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const problems = [];
  if (result.status !== status)
    problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
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

check('a tree where everything runs the pinned bun passes', {
  root: tree('clean'),
  status: 0,
  contains: ['OK', '2 Dockerfile bun source(s)', '1 setup-bun step(s)'],
});

check('an oven/bun stage on another version fails', {
  root: tree('oven-drift', { 'packages/api/Dockerfile': OVEN_STAGE.replace(PIN, '1.4.2') }),
  status: 1,
  contains: ['packages/api/Dockerfile', 'oven/bun:1.4.2-slim', `bun@${PIN}`],
});

check('a literal oven/bun tag behind --platform on another version fails', {
  root: tree('oven-platform', {
    'packages/api/Dockerfile':
      'FROM --platform=linux/arm64 oven/bun:1.5.0-alpine AS b\nRUN bun x\n',
  }),
  status: 1,
  contains: ['oven/bun:1.5.0-alpine'],
});

check('an untagged oven/bun fails', {
  root: tree('oven-untagged', {
    'packages/api/Dockerfile': 'FROM oven/bun AS b\nRUN bun install\n',
  }),
  status: 1,
  contains: ['untagged'],
});

check('a build arg with no default fails', {
  root: tree('oven-no-default', {
    'packages/api/Dockerfile': OVEN_STAGE.replace(`ARG BUN_VERSION=${PIN}`, 'ARG BUN_VERSION'),
  }),
  status: 1,
  contains: ['no default'],
});

check('the install script with no version fails', {
  root: tree('script-unpinned', {
    'packages/integrations/Dockerfile': INSTALL_SCRIPT.replace(/ "bun-v\$\{BUN_VERSION\}"/, ''),
  }),
  status: 1,
  contains: ['packages/integrations/Dockerfile', 'installs the newest bun'],
});

check('the install script on another version fails', {
  root: tree('script-drift', {
    'packages/integrations/Dockerfile': INSTALL_SCRIPT.replace(PIN, '1.4.2'),
  }),
  status: 1,
  contains: ['installs bun-v1.4.2'],
});

check('a Dockerfile that runs bun from an image the gate cannot see fails', {
  root: tree('unseen-bun', {
    'packages/integrations/Dockerfile': 'FROM node:22-slim\nRUN bun install --frozen-lockfile\n',
  }),
  status: 1,
  contains: ['neither an oven/bun stage nor'],
});

check('a setup-bun step with a literal version fails, even the pinned one', {
  root: tree('workflow-literal', {
    '.github/workflows/ci.yml': SETUP_BUN.replace(
      'bun-version-file: package.json',
      `bun-version: ${PIN}`,
    ),
  }),
  status: 1,
  contains: ['ci.yml:6', `names bun-version ${PIN}`],
});

check('a setup-bun step with no version fails', {
  root: tree('workflow-latest', {
    '.github/workflows/ci.yml': SETUP_BUN.replace(
      '        with:\n          bun-version-file: package.json\n',
      '',
    ),
  }),
  status: 1,
  contains: ['has no `bun-version-file: package.json`'],
});

check('moving packageManager without the images fails', {
  root: tree('pin-moved', { 'package.json': JSON.stringify({ packageManager: 'bun@1.4.4' }) }),
  status: 1,
  contains: ['oven/bun:1.4.3-slim', 'installs bun-v1.4.3', 'bun@1.4.4'],
});

check('a .bun-version that disagrees fails', {
  root: tree('bun-version-file', { '.bun-version': '1.3.14\n' }),
  status: 1,
  contains: ['.bun-version says 1.3.14'],
});

/** The guards that separate "nothing is wrong" from "nothing was looked at". */
check('a root package.json with no bun packageManager fails', {
  root: tree('no-pin', { 'package.json': JSON.stringify({ name: 'x' }) }),
  status: 1,
  contains: ['must pin `packageManager`'],
});

check('Dockerfiles with no bun in any of them fail, rather than passing over zero', {
  root: tree('no-docker-bun', {
    'packages/api/Dockerfile': 'FROM node:22-slim\nRUN node -v\n',
    'packages/integrations/Dockerfile': null,
  }),
  status: 1,
  contains: ['no bun in any of them', 'measuring nothing'],
});

check('workflows with no setup-bun step fail, rather than passing over zero', {
  root: tree('no-setup-bun', {
    '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: echo hi\n',
  }),
  status: 1,
  contains: ['no `oven-sh/setup-bun` step', 'measuring nothing'],
});

if (failures > 0) {
  console.error(`\ncheck-bun-pin is not behaving: ${String(failures)} case(s) failed.`);
  process.exit(1);
}

console.log('\ncheck-bun-pin: every case behaved — it can still fail, and still passes.');
