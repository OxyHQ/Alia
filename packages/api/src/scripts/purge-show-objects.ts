#!/usr/bin/env bun
/**
 * One-shot purge: delete the audio the OLD flat `shows` table produced.
 *
 * Migration 0034 drops the table. This removes what the table pointed at, and
 * it is a script rather than a migration for one reason: S3 is not the
 * migration ledger's subject. A `DROP TABLE` that also had to reach an object
 * store would be a migration that can half-succeed with no record of which
 * half, on a ledger whose whole contract is that a file either applied or did
 * not.
 *
 * ## What it deletes, and what it deliberately does not
 *
 * The old pipeline wrote to exactly two prefixes, both under `{NODE_ENV}/`:
 *
 *   {env}/shows/{showId}-{uuid}.mp3            the finished show
 *   {env}/shows/{userId}/{showId}/segment-…    one object per dialogue segment
 *
 * The second is nested INSIDE the first, so `{env}/shows/` covers both — which
 * is why this takes one prefix and not two.
 *
 * The NEW pipeline writes segments to `{env}/show-segments/`, deliberately a
 * different prefix rather than a subfolder. Sharing one would make this purge
 * unable to tell the dead recordings from a live episode being assembled while
 * it runs, and the safe version of that ambiguity is the one where the two
 * cannot be confused at all.
 *
 * Safe to run twice: the second run finds nothing and reports zero.
 *
 * Usage:
 *   DRY_RUN=1 bun src/scripts/purge-show-objects.ts   # count only, no deletes
 *   bun src/scripts/purge-show-objects.ts             # perform the purge
 */

import { deleteS3Prefix, listS3ObjectKeys } from '../lib/s3.js';

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

/**
 * Built from `NODE_ENV` exactly as `uploadToS3` built it, and asserted
 * non-empty before it is used.
 *
 * An empty prefix means "the whole bucket" to `ListObjectsV2`, so the one thing
 * that must not happen here is a prefix computed from an unset variable.
 * `listS3ObjectKeys` refuses an empty string as well — two checks, because this
 * script's failure mode is unrecoverable and the cost of the second is a line.
 */
const PREFIX = `${NODE_ENV}/shows/`;

async function purge(): Promise<void> {
  if (!process.env.AWS_S3_BUCKET) {
    throw new Error('AWS_S3_BUCKET is required to purge stored show audio');
  }
  if (NODE_ENV.trim() === '') {
    throw new Error('NODE_ENV is empty, which would make the prefix the whole bucket');
  }

  console.log(
    `Purging ${PREFIX} from ${process.env.AWS_S3_BUCKET} ` +
      `(${DRY_RUN ? 'DRY RUN — no deletes' : 'LIVE — objects will be deleted'})...`,
  );

  if (DRY_RUN) {
    const keys = await listS3ObjectKeys(PREFIX);
    console.log(`[dry-run] ${keys.length} object(s) would be deleted`);
    // The first few, so an operator can see WHAT matched rather than only how
    // much. A count alone cannot distinguish the right prefix from a wrong one
    // that happens to hold a similar number of objects.
    for (const key of keys.slice(0, 10)) console.log(`[dry-run]   ${key}`);
    if (keys.length > 10) console.log(`[dry-run]   … and ${keys.length - 10} more`);
    return;
  }

  const deleted = await deleteS3Prefix(PREFIX);
  console.log(`✓ deleted ${deleted} object(s) under ${PREFIX}`);

  // Read back, rather than trusting the count just reported. A delete that
  // silently skipped a batch and one that removed everything report the same
  // shape of success, and only a second listing tells them apart.
  const remaining = await listS3ObjectKeys(PREFIX);
  if (remaining.length > 0) {
    throw new Error(
      `${remaining.length} object(s) still under ${PREFIX} after the purge — re-run, ` +
        `or check the task role's s3:DeleteObject permission`,
    );
  }
  console.log('Verified: nothing remains under the prefix.');
}

purge().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Show object purge failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
