/**
 * `check-dns-record-filters.mjs` must still be able to FAIL.
 *
 * It exists because two workflows indexed `.result[0]` into a list holding more
 * than one record type. A gate against that is worth its runtime only while a
 * tree carrying the bug turns it red, and the day that stops being true reads
 * exactly like a repository with nothing wrong in it.
 *
 * The case that matters most here is `type=A`. The gate exempts a query pinning
 * `type=CNAME`, because DNS forbids a second CNAME at one name and the server
 * therefore guarantees what indexing assumes. Every other type narrows the type
 * WITHOUT narrowing the count — one name may hold several `A` records — so an
 * exemption that let `&type=A` through would be a door nobody watches. This
 * walks up to that door and requires it shut.
 *
 * The other case that earns its place is the SCRIPT one. The delete logic left
 * the workflows for `.github/scripts` in #444, and the first version of the
 * gate read only `*.yml` — it passed a violation planted in the operational
 * script. `test-*.sh` must stay exempt in the same breath, because
 * `test-cloudflare-cutover.sh` carries the historical broken step verbatim as
 * its own control.
 *
 * The REAL script, spawned the way CI spawns it, rather than its internals
 * imported: the exit code is the interface.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), 'check-dns-record-filters.mjs');

const workspace = mkdtempSync(join(tmpdir(), 'check-dns-record-filters-'));
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

function tree(name, files) {
  const root = join(workspace, name);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

let failures = 0;

function check(name, { root, status, contains = [] }) {
  const result = spawnSync('node', [GATE, '--root', root], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const problems = [];
  if (result.status !== status) problems.push(`exited ${String(result.status)}, expected ${String(status)}`);
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

/** A workflow whose one step runs `script`. */
const workflow = (script) => `name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: probe
        run: |
          ${script}
`;

const QUERY = 'https://api.cloudflare.com/client/v4/zones/$Z/dns_records?name=$H';

check('an unpinned dns_records response indexed at [0]', {
  root: tree('unpinned', {
    '.github/workflows/probe.yml': workflow(
      `curl -sS "${QUERY}" -o /tmp/rec.json\n          rec=$(jq -r '.result[0].id' /tmp/rec.json)`,
    ),
  }),
  status: 1,
  contains: ['reads .result[0] from /tmp/rec.json', 'dns_records response'],
});

// THE DOOR. `type=A` pins the type and not the count: a name may hold
// 192.0.2.1 AND 192.0.2.2, and `.result[0]` picks one of them blindly — the
// original bug, wearing a filter that looks like a fix.
check('a dns_records response pinned to type=A indexed at [0]', {
  root: tree('pinned-a', {
    '.github/workflows/probe.yml': workflow(
      `# a name may hold 192.0.2.1 and 192.0.2.2 at once\n          curl -sS "${QUERY}&type=A" -o /tmp/rec.json\n          rec=$(jq -r '.result[0].id' /tmp/rec.json)`,
    ),
  }),
  status: 1,
  contains: ['reads .result[0] from /tmp/rec.json'],
});

check('a dns_records response pinned to type=CNAME indexed at [0] is allowed', {
  root: tree('pinned-cname', {
    '.github/workflows/probe.yml': workflow(
      `curl -sS "${QUERY}&type=CNAME" -o /tmp/rec.json\n          rec=$(jq -r '.result[0].id' /tmp/rec.json)`,
    ),
  }),
  status: 0,
});

check('a zones response indexed at [0] is allowed', {
  root: tree('zones', {
    '.github/workflows/probe.yml': workflow(
      `curl -sS "https://api.cloudflare.com/client/v4/zones?name=$Z" -o /tmp/z.json\n          id=$(jq -r '.result[0].id' /tmp/z.json)`,
    ),
  }),
  status: 0,
});

check('an operational script indexed at [0]', {
  root: tree('script', {
    '.github/workflows/probe.yml': workflow('true'),
    '.github/scripts/records.sh': `curl -sS "${QUERY}" -o /tmp/rec.json\nrec=$(jq -r '.result[0].id' /tmp/rec.json)\n`,
  }),
  status: 1,
  contains: ['.github/scripts/records.sh', 'reads .result[0]'],
});

// The historical bug has to be allowed to live in the test that reproduces it.
check('the same violation inside a test script is a fixture, not a defect', {
  root: tree('test-script', {
    '.github/workflows/probe.yml': workflow('true'),
    '.github/scripts/test-records.sh': `curl -sS "${QUERY}" -o /tmp/rec.json\nrec=$(jq -r '.result[0].id' /tmp/rec.json)\n`,
  }),
  status: 0,
});

if (failures > 0) {
  console.error(`\ncheck-dns-record-filters can no longer fail on ${failures} case(s).`);
  process.exit(1);
}
console.log('\ntest-check-dns-record-filters: OK — the gate still fails on every tree built to be broken.');
