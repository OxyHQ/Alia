/**
 * The backfill audit runner.
 *
 *   bun src/db/backfill-audit/run.ts \
 *     --uri="$MONGODB_URI" \
 *     --expect-populated=agents
 *
 * Reads NOTHING and writes NOTHING. Every check counts; none repairs. A repair
 * that ran automatically here would be a repair nobody decided on, and every
 * item on this list is a decision — most of all the dangling references, whose
 * remedy is to discard rows.
 *
 * ## Exit codes
 *
 * - `0` — every check ran and no BLOCKING finding was non-zero.
 * - `1` — a blocking finding is non-zero, or a precondition failed, or a check
 *   scanned nothing it should have scanned.
 *
 * An informational finding never changes the exit code, because "here is a
 * number somebody needs" and "the backfill will fail" are opposite instructions
 * and a single amber state collapses them.
 */

import { AUDIT_CHECKS } from './registry';
import { AuditPreconditionError, collectionsRequiredBy, openAuditSource } from './source';
import type { AuditCheckResult } from './types';

interface Args {
  uri: string;
  databaseName?: string;
  expectPopulated: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const expectPopulated: string[] = [];
  let uri = '';
  let databaseName: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--uri=')) uri = arg.slice('--uri='.length);
    else if (arg.startsWith('--expect-populated=')) {
      expectPopulated.push(arg.slice('--expect-populated='.length));
    } else if (arg.startsWith('--database=')) databaseName = arg.slice('--database='.length);
    else throw new AuditPreconditionError(`Unrecognised argument: ${arg}`);
  }

  if (!uri) {
    throw new AuditPreconditionError(
      '--uri is required. It is not read from the environment, because an audit that picks up ' +
        'whatever connection happens to be configured is the same class of mistake as one that ' +
        'derives its database name.',
    );
  }
  return { uri, databaseName, expectPopulated };
}

function report(result: AuditCheckResult): boolean {
  const blocked = result.severity === 'blocking' && result.findings.some((f) => f.count > 0);
  const total = result.findings.reduce((sum, f) => sum + f.count, 0);

  process.stdout.write(
    `\n${result.checkId}  [${result.severity}]  ` +
      `${total} finding(s) across ${result.documentsScanned} scanned document(s)\n`,
  );
  for (const finding of result.findings) {
    const marker = finding.count > 0 ? '!' : ' ';
    process.stdout.write(`  ${marker} ${finding.key.padEnd(30)} ${finding.count}  ${finding.subject}\n`);
    if (finding.sample.length > 0) {
      process.stdout.write(`      sample: ${finding.sample.join(', ')}\n`);
    }
  }
  return blocked;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const source = await openAuditSource({
    uri: args.uri,
    databaseName: args.databaseName,
    expectPopulated: args.expectPopulated,
    requiredCollections: collectionsRequiredBy(AUDIT_CHECKS),
  });

  try {
    process.stdout.write(`backfill audit against '${source.db.databaseName}'\n`);
    let blocked = false;
    for (const check of AUDIT_CHECKS) {
      const result = await check.run(source.db);
      if (report(result)) blocked = true;
    }
    process.stdout.write(
      blocked
        ? '\nBLOCKED — resolve or explicitly discard the findings above before backfilling.\n'
        : '\nNo blocking findings.\n',
    );
    return blocked ? 1 : 0;
  } finally {
    await source.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`backfill audit did not run: ${message}\n`);
    process.exitCode = 1;
  });
