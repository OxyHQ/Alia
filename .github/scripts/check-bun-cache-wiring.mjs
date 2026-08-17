/**
 * Every job that runs `bun install` restores bun's install cache first.
 *
 * ## What this is protecting
 *
 * `@whiskeysockets/baileys` declares `libsignal` as a git dependency that is not
 * on npm, so `bun install` fetches a tarball from GitHub. That fetch is
 * unauthenticated and CANNOT be authenticated — `GITHUB_TOKEN`,
 * `GITHUB_API_DOMAIN` and `git config url."…".insteadOf` are all inert for
 * `bun install`, measured and recorded in `ci.yml`'s own comment. Anonymous
 * GitHub requests are limited per IP, and on 2026-08-17 every job in a CI run
 * failed at "Install dependencies" with a 504 and then a 429.
 *
 * A warm cache satisfies the pinned ref with zero GitHub requests, so the cache
 * step is the only thing standing between this repository and that outage. It
 * is one `uses:` line, it is easy to delete while tidying a workflow, and
 * deleting it breaks nothing until the day GitHub rate-limits us again.
 *
 * ## Why this shape of check, and not the obvious one
 *
 * The tempting assertion is "fail the install if it talks to codeload.github.com
 * at all". That would be a gate whose cheapest green is never changing
 * `bun.lock`: a cache MISS legitimately fetches, and the first run after any
 * dependency bump is a miss. It would fire on the correct behaviour and on the
 * regression identically, so it would be turned off within a week.
 *
 * What actually regresses is the WIRING, and the wiring is static, so it is
 * asserted statically: every job that installs has a cache restore before it,
 * and it caches the right directory.
 *
 * `node_modules` is called out separately because caching it instead is the
 * plausible wrong version of this fix — it looks equivalent, it is faster still,
 * and it makes the tree a stale artefact that no longer reflects `bun.lock`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = '.github/workflows';
const CACHE_PATH = '.bun/install/cache';

/**
 * Steps of one job, as `{ uses, run, path }`, in order.
 *
 * A hand-rolled reader rather than a YAML dependency: this runs in the cheapest
 * job in the workflow, before anything is installed, so it cannot import one.
 * It reads the two-space-indented `- name:`/`- uses:` step list under a job,
 * which is the shape every job in this file uses.
 */
function stepsOf(lines, startIndex) {
  const steps = [];
  let current = null;
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    // A new job begins at two-space indentation with a trailing colon.
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(line) && i > startIndex) break;
    const stepStart = line.match(/^ {6}- (uses|name):\s*(.*)$/);
    if (stepStart) {
      current = { uses: '', run: '', path: '' };
      steps.push(current);
      if (stepStart[1] === 'uses') current.uses = stepStart[2].trim();
      continue;
    }
    if (current === null) continue;
    const uses = line.match(/^ {8}uses:\s*(.*)$/);
    if (uses) current.uses = uses[1].trim();
    const path = line.match(/^ {10}path:\s*(.*)$/);
    if (path) current.path = path[1].trim();
    if (/^ {8}run:/.test(line) || /^ {10}\S/.test(line)) current.run += `${line}\n`;
  }
  return steps;
}

function jobsOf(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => l === 'jobs:');
  if (jobsAt === -1) return [];
  const out = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const job = lines[i].match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (job) out.push({ name: job[1], steps: stepsOf(lines, i + 1) });
  }
  return out;
}

const failures = [];
let installingJobs = 0;
let scannedFiles = 0;

for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  scannedFiles += 1;
  for (const { name, steps } of jobsOf(text)) {
    const installAt = steps.findIndex((s) => /\bbun install\b/.test(s.run));
    if (installAt === -1) continue;
    installingJobs += 1;

    const cacheAt = steps.findIndex((s) => s.uses.startsWith('actions/cache'));
    if (cacheAt === -1) {
      failures.push(`${file} / ${name}: runs \`bun install\` with no cache restore`);
      continue;
    }
    if (cacheAt > installAt) {
      failures.push(`${file} / ${name}: cache restore runs AFTER \`bun install\`, so it never warms it`);
    }
    const cachePath = steps[cacheAt].path;
    if (!cachePath.includes(CACHE_PATH)) {
      failures.push(`${file} / ${name}: caches "${cachePath}", expected a path containing ${CACHE_PATH}`);
    }
    if (cachePath.includes('node_modules')) {
      failures.push(`${file} / ${name}: caches node_modules, which makes the tree a stale artefact`);
    }
  }
}

// Floors. Without these a broken reader reports a clean zero, which is exactly
// what this check would look like if it silently stopped finding anything.
if (scannedFiles < 2) {
  console.error(`check-bun-cache-wiring: read only ${scannedFiles} workflow file(s); the path is wrong.`);
  process.exit(1);
}
if (installingJobs < 5) {
  console.error(
    `check-bun-cache-wiring: found only ${installingJobs} job(s) running \`bun install\`; expected at least 5. ` +
      `Either the reader broke or jobs were removed — both need a human.`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error('check-bun-cache-wiring: a job installs without warming bun’s cache first.\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nThe git dependency `libsignal` is fetched from GitHub unauthenticated and cannot be\n' +
      'authenticated; a warm cache is what stops that request happening. See the comment at\n' +
      'the top of .github/workflows/ci.yml.',
  );
  process.exit(1);
}

console.log(
  `check-bun-cache-wiring: OK — ${installingJobs} installing jobs across ${scannedFiles} workflows, ` +
    `each restoring ~/${CACHE_PATH} before \`bun install\`.`,
);
