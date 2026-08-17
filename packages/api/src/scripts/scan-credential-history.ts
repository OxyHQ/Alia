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
 *  - `1` — a credential is in this repository's history and NOT in the ledger.
 *    A new leak, or a rewritten history. Rotate first, then record it.
 *  - `2` — every finding is ledgered, but at least one is still pending
 *    rotation. Not a new leak; a job someone has not finished.
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
  const pending: CredentialFinding[] = [];
  const seen = new Set<string>();

  for (const finding of result.findings) {
    const key = findingKey(finding);
    // One line per VALUE, not per place it appears: the same fixture literal
    // lives in two files, and printing it twice reads as two problems.
    if (seen.has(key)) continue;
    seen.add(key);
    const known = ledger.get(key);
    if (known === undefined) unledgered.push(finding);
    else if (known.rotatedAt === null && known.classification === 'credential') {
      pending.push(finding);
    }
  }

  const stale = KNOWN_DISCLOSURES.filter((entry) => !seen.has(entry.key));

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

  if (unledgered.length > 0) {
    process.stdout.write('UNLEDGERED — a credential is in the history and nobody has recorded it:\n');
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
    for (const finding of pending) {
      const known = ledger.get(findingKey(finding));
      process.stdout.write(`  ${describe(finding)}\n      ${known?.note ?? ''}\n`);
    }
    process.stdout.write(
      '\nSee docs/runbooks/credential-rotation.md § Rotating the keys found in git history.\n',
    );
    return 2;
  }

  process.stdout.write('Every finding is ledgered and rotated.\n');
  return stale.length > 0 ? 1 : 0;
}

const result = await scanGitHistory(REPO_ROOT);
process.exitCode = report(result);
