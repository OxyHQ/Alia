/**
 * `bun run scan:credentials` — the git-history credential audit, on demand.
 *
 * The same scan `lib/security/__tests__/credential-scan.test.ts` runs in CI,
 * with a report instead of an assertion. Run it when a leak is suspected, when a
 * ledger entry needs its paths and commits, or after a rotation to record the
 * date.
 *
 * Exit codes are the point of running it in a pipeline:
 *
 *  - `0` — every finding is in the ledger and none is pending rotation.
 *  - `1` — a credential is in this repository's history and NOT in the ledger
 *    (a new leak: rotate first, then record it), a ledger entry matches nothing
 *    (the history moved: date its `purgedFromHistory`), or a purged value is back
 *    (a branch from before the rewrite was merged).
 *  - `2` — every finding is ledgered, but at least one disclosed credential is
 *    still pending rotation, whether or not the history still holds it. Not a
 *    new leak; a job someone has not finished.
 *
 * The values themselves are never printed. A scanner that echoes what it found
 * moves the credential into a second place — a terminal, a CI log — which is the
 * failure `docs/runbooks/provider-credential-exposure.md` exists to stop.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanGitHistory,
  type CredentialFinding,
  type CredentialScanResult,
} from '../lib/security/credential-scan.js';
import {
  findingKey,
  KNOWN_DISCLOSURES,
  type KnownDisclosure,
} from '../lib/security/known-disclosures.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function describe(finding: CredentialFinding): string {
  const where = finding.paths.length === 0 ? '(no path)' : finding.paths.join(', ');
  return `${finding.pattern}:${finding.fingerprint}  blob ${finding.blob.slice(0, 12)}  +${String(finding.offset)}  ${String(finding.length)} chars  prefix ${finding.prefix}…  ${where}`;
}

function report(result: CredentialScanResult): number {
  const ledger = new Map<string, KnownDisclosure>(
    KNOWN_DISCLOSURES.map((entry) => [entry.key, entry]),
  );

  const unledgered: CredentialFinding[] = [];
  const firstFinding = new Map<string, CredentialFinding>();
  const seen = new Set<string>();

  for (const finding of result.findings) {
    const key = findingKey(finding);
    // One line per VALUE, not per place it appears: the same fixture literal
    // lives in two files, and printing it twice reads as two problems.
    if (seen.has(key)) continue;
    seen.add(key);
    firstFinding.set(key, finding);
    if (!ledger.has(key)) unledgered.push(finding);
  }

  const stale = KNOWN_DISCLOSURES.filter(
    (entry) => entry.purgedFromHistory === null && !seen.has(entry.key),
  );
  const resurfaced = KNOWN_DISCLOSURES.filter(
    (entry) => entry.purgedFromHistory !== null && seen.has(entry.key),
  );
  // From the LEDGER, not the findings: a purged credential is invisible to the
  // scan and exactly as published as before, so it stays pending until rotated.
  const pending = KNOWN_DISCLOSURES.filter(
    (entry) => entry.classification === 'credential' && entry.rotatedAt === null,
  );

  process.stdout.write(
    `scanned ${String(result.blobsScanned)} blobs (${String(result.bytesScanned)} bytes) ` +
      `across ${String(result.commitsReachable)} commits reachable from HEAD\n` +
      `${String(result.findings.length)} finding(s), ${String(KNOWN_DISCLOSURES.length)} ledgered\n\n`,
  );

  if (stale.length > 0) {
    process.stdout.write(
      'LEDGER ENTRIES THAT MATCHED NOTHING — the history moved, or the entry is wrong:\n',
    );
    for (const entry of stale) process.stdout.write(`  ${entry.key}  ${entry.note}\n`);
    process.stdout.write('\n');
  }

  if (resurfaced.length > 0) {
    process.stdout.write(
      'PURGED VALUES BACK IN HISTORY — a branch from before the rewrite was merged:\n',
    );
    for (const entry of resurfaced) {
      process.stdout.write(`  ${entry.key}  purged ${String(entry.purgedFromHistory)}\n`);
    }
    process.stdout.write('\n');
  }

  if (unledgered.length > 0) {
    process.stdout.write(
      'UNLEDGERED — a credential is in the history and nobody has recorded it:\n',
    );
    for (const finding of unledgered) process.stdout.write(`  ${describe(finding)}\n`);
    process.stdout.write(
      '\nRotate the credential at its provider FIRST. Rewriting history does not\n' +
        'un-publish a value that has been pushed. Then add it to\n' +
        'packages/api/src/lib/security/known-disclosures.ts and to\n' +
        'docs/runbooks/provider-credential-exposure.md.\n',
    );
    return 1;
  }

  if (pending.length > 0) {
    process.stdout.write('PENDING ROTATION — disclosed, acknowledged, not yet rotated:\n');
    for (const entry of pending) {
      const finding = firstFinding.get(entry.key);
      const where =
        finding !== undefined
          ? describe(finding)
          : `${entry.key}  purged from history ${String(entry.purgedFromHistory)}; ` +
            'still published in pre-rewrite clones and GitHub pull refs';
      process.stdout.write(`  ${where}\n      ${entry.note}\n`);
    }
    process.stdout.write(
      '\nSee docs/runbooks/credential-rotation.md § Rotating the keys found in git history.\n',
    );
  }

  // A ledger that no longer matches the history outranks pending rotation:
  // purged credentials stay pending until someone rotates them, and a `2` must
  // not hide that the census itself is wrong.
  if (stale.length > 0 || resurfaced.length > 0) return 1;
  if (pending.length > 0) return 2;
  process.stdout.write('Every finding is ledgered and every disclosed credential rotated.\n');
  return 0;
}

const result = await scanGitHistory(REPO_ROOT);
process.exitCode = report(result);
