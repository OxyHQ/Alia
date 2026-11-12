/**
 * Retired vocabulary cannot return.
 *
 * Two retirements, each a clean cut with no compatibility code, so any trace of
 * them in the tree is either dead code or a lane coming back:
 *
 *  1. The retired product routes (`<kaana|alia>-lite`, `<kaana|alia>-v1-*`).
 *  2. The native-product-agent lane (ADR 0020 §8): its manifest and bootstrap,
 *     requester assertions, the internal MCP pilot flag, the two delegation
 *     tools `consultAgent` replaced, and the negotiated stream features. (The
 *     check that an agent carries no application binding, ADR 0021, lives with
 *     the agent schemas in OxyHQ/Gemies.)
 *
 * Records of the past keep their words: changelogs are history, not code. Every pattern is
 * spelled in pieces so this file does not match itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n');

const SELF = 'scripts/check-retired-vocabulary.mjs';

const retiredProductRoutes = new RegExp(
  `(?:${'kaana'}|${'alia'})-(?:lite|v1(?:-[a-z0-9-]+)?)`,
  'g',
);

/**
 * History that names the lane on purpose. The ADRs, audits and migration
 * inventories that also did moved to OxyHQ/Gemies with the backend.
 */
const laneHistory = [/(?:^|\/)CHANGELOG\.md$/];
const retiredLane = new RegExp(
  [
    `native-${'product-agent'}`,
    `Requester${'Assertion'}`,
    `requester-${'assertion'}`,
    `ALIA_INTERNAL_${'MCP_PILOT'}`,
    `\\bask${'Agent'}\\b`,
    `\\bdelegateTo${'Agent'}\\b`,
    `\\bstream${'Features'}\\b`,
  ].join('|'),
  'g',
);

const failures = [];

function report(file, source, pattern, why) {
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(`${file}:${line}: ${match[0]} (${why})`);
  }
}

for (const file of tracked) {
  if (file === SELF) continue;
  const url = new URL(file, root);
  // `git ls-files --cached` also reports a tracked file deleted in the current
  // change. A deletion cannot introduce retired vocabulary.
  if (!existsSync(url)) continue;
  const source = readFileSync(url, 'utf8');
  report(file, source, retiredProductRoutes, 'retired product route');
  if (!laneHistory.some((history) => history.test(file))) {
    report(file, source, retiredLane, 'retired native-product-agent lane, ADR 0020 §8');
  }
}

if (failures.length > 0) {
  console.error('Retired vocabulary found:\n' + failures.join('\n'));
  process.exit(1);
}

console.log(`retired-vocabulary: OK — ${tracked.length} tracked files checked`);
