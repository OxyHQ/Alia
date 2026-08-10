import { MongoClient, type Db } from 'mongodb';
import type { AuditCheck } from './types';

/**
 * Opening the source database, and refusing to open the wrong one.
 *
 * ## The database name is a LITERAL and the runner will not start without it
 *
 * `alia-development` lives on the SAME Mongo host as `alia-production`, with 654
 * documents in it, and `integrations-production` sits beside them. So an audit
 * that derives its source from `NODE_ENV`, from a service name, or from any
 * pattern can point at a seeded development copy and report a clean,
 * successful, entirely meaningless run — the failure this whole module is
 * shaped around, because nothing about the output would look wrong.
 *
 * `db.databaseName` is therefore asserted against the literal before a byte is
 * read. CONVENTIONS.md states the rule; this is its enforcement.
 *
 * ## And a successful connection is not evidence the database has anything in it
 *
 * Every count in a fresh, empty or wrong database is zero, and zero is exactly
 * what a clean audit looks like. So the caller must NAME a collection it has
 * independently confirmed holds rows, and the runner refuses if that collection
 * is empty. It is a required input rather than a defaulted one because a
 * positive control somebody can omit is a positive control nobody runs.
 *
 * It is deliberately NOT a hardcoded list here. The only per-collection figures
 * available are from a whole-host census dated 2026-08-09, and a constant built
 * from numbers that may have moved would fail for the wrong reason — or, worse,
 * pass for the wrong reason. Whoever runs the audit has just looked at the
 * database; they are the one who can supply a fact with today's date on it.
 */

/**
 * The one database this audit is allowed to read.
 *
 * A literal, never derived. Changing it is a code change and a review, which is
 * the point.
 */
export const SOURCE_DATABASE = 'alia-production';

export interface AuditSourceOptions {
  readonly uri: string;
  /**
   * The database to open. Defaults to the literal above; a caller may pass a
   * different one ONLY so the test suite can exercise this module against a
   * throwaway database. Production runs pass nothing.
   */
  readonly databaseName?: string;
  /**
   * Collections the caller has confirmed are populated. At least one is
   * required — see the module comment.
   */
  readonly expectPopulated: readonly string[];
  /** Every collection the selected checks will read. All must exist. */
  readonly requiredCollections: readonly string[];
}

export interface AuditSource {
  readonly db: Db;
  close(): Promise<void>;
}

export class AuditPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditPreconditionError';
  }
}

/**
 * Connect, then refuse to proceed unless every precondition holds.
 *
 * The order matters: the database identity is checked FIRST, because every
 * later assertion is meaningless if it is being made about the wrong database.
 */
export async function openAuditSource(options: AuditSourceOptions): Promise<AuditSource> {
  if (options.expectPopulated.length === 0) {
    throw new AuditPreconditionError(
      'No positive control given. Name at least one collection you have confirmed holds rows ' +
        '(--expect-populated=<collection>): without one, a connection to an empty or wrong ' +
        'database produces zeroes that read as a clean audit.',
    );
  }

  const client = new MongoClient(options.uri);
  await client.connect();

  const close = () => client.close();

  try {
    const db = client.db(options.databaseName ?? SOURCE_DATABASE);
    const expected = options.databaseName ?? SOURCE_DATABASE;

    if (db.databaseName !== expected) {
      throw new AuditPreconditionError(
        `Connected to database '${db.databaseName}' but expected '${expected}'. ` +
          'The source is a literal precisely because a derived one can point at ' +
          "'alia-development' on the same host and report a successful run.",
      );
    }

    /**
     * Every collection a check names must EXIST. A Mongoose collection name is
     * an arbitrary third argument, so a literal here can simply be wrong — and
     * a query against a collection that does not exist returns zero documents
     * rather than an error, which is the same output as a clean result.
     */
    const present = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );

    const missing = options.requiredCollections.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new AuditPreconditionError(
        `Collections named by the selected checks do not exist in '${db.databaseName}': ` +
          `${missing.join(', ')}. A query against a missing collection counts zero, which is ` +
          'indistinguishable from a clean result — so this is a failure, not a skip.',
      );
    }

    const emptyControls: string[] = [];
    for (const name of options.expectPopulated) {
      if (!present.has(name)) {
        throw new AuditPreconditionError(
          `Positive control '${name}' does not exist in '${db.databaseName}'.`,
        );
      }
      if ((await db.collection(name).countDocuments({}, { limit: 1 })) === 0) {
        emptyControls.push(name);
      }
    }
    if (emptyControls.length > 0) {
      throw new AuditPreconditionError(
        `Positive control(s) empty in '${db.databaseName}': ${emptyControls.join(', ')}. ` +
          'The connection succeeded and the database has nothing in it, so every count this ' +
          'audit produces would be zero for a reason that has nothing to do with the data.',
      );
    }

    return { db, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Every collection the given checks read, deduped. */
export function collectionsRequiredBy(checks: readonly AuditCheck[]): string[] {
  return [...new Set(checks.flatMap((check) => check.collections))].sort();
}
