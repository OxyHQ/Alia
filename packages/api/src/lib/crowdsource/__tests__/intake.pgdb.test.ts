import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { setUpTestDatabase, type TestDatabaseHandle } from '../../../db/testDatabase.js';
import { moderationOutboxes, reports } from '../../../db/schema/moderation.js';
import { reportSubmitEventId } from '../../../db/moderation/outboxRepository.js';
import { ReportCategory, ReportedType } from '../../../domain/report.js';
import { createReport, DuplicateReportError } from '../intake.js';

/**
 * Intake through the SERVICE, against a real Postgres.
 *
 * `reportRepository.pgdb.test.ts` covers the statement mechanics; what this file
 * covers is the decision the service makes before the transaction opens — whether
 * the reported type has a subject provider — and the coupling between that one
 * fact and BOTH of the things it decides: the report's `localStatus` and whether
 * an outbox row exists at all.
 *
 * That coupling is the reason the two writes are in one transaction rather than
 * carefully ordered, so it is asserted from both sides rather than by trusting
 * that they were computed together.
 */

let db: ApiDatabase;
let database: TestDatabaseHandle;

/**
 * A PRIVATE database for this file.
 *
 * The suite's global setup makes ONE database for the whole run and vitest runs
 * FILES IN PARALLEL, so the moderation files would otherwise share `reports`
 * and `moderation_outboxes` — and each one's `afterEach` would wipe the others'
 * fixtures mid-test. Measured: that is exactly what happened, and it surfaced as
 * "unique violation but no existing row found", which names nothing about the
 * cause.
 *
 * Namespacing the fixtures would fix the COLLISION but not the ASSERTIONS. The
 * co-commit test's entire claim is "the table holds NO row" and "exactly ONE
 * row"; scoping those counts to a prefix is one subtle predicate away from an
 * assertion that cannot fail — and that assertion is what the whole slice rests
 * on. An own database keeps a global count meaning what it says.
 */
beforeAll(async () => {
  database = await setUpTestDatabase();
  const connected = connectPostgres(database.databaseUrl);
  if (!connected) throw new Error('could not connect to this file\'s throwaway database');
  db = connected;
}, 120_000);

afterEach(async () => {
  await db.execute(sql`truncate ${reports}, ${moderationOutboxes}`);
});

afterAll(async () => {
  await closePostgres();
  await database.drop();
});

const REPORTER = 'oxy-user-1';

describe('a deliverable report', () => {
  it('commits the report and its delivery event together', async () => {
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.AGENT,
      reportedId: 'agent-1',
      categories: [ReportCategory.SPAM],
    });

    expect(result.report.localStatus).toBe('queued');
    expect(result.outboxEventId).toBe(reportSubmitEventId(result.report.id));

    const [event] = await db.select().from(moderationOutboxes);
    expect(event?.id).toBe(reportSubmitEventId(result.report.id));
    expect(event?.status).toBe('pending');
    expect(event?.kind).toBe('report.submit');
    // The worker looks the report up by this, so a mismatch would be a delivery
    // event that can never find its report.
    expect((event?.payload as { reportId?: string }).reportId).toBe(result.report.id);
  });

  /**
   * The id is minted by the service, BEFORE the insert, because the event id is
   * derived from it and both rows are written in one pass. Mongo got this from a
   * client-generated ObjectId; `reports.id` has no database default for the same
   * reason.
   */
  it('mints an id the caller can read back', async () => {
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.AGENT,
      reportedId: 'agent-1',
      categories: [ReportCategory.SPAM],
    });

    expect(result.report.id).toMatch(/^[0-9a-f-]{36}$/);
    const [stored] = await db.select().from(reports);
    expect(stored?.id).toBe(result.report.id);
  });

  it('stores the reporter, the details and the categories as given', async () => {
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.AGENT,
      reportedId: 'agent-1',
      categories: [ReportCategory.SPAM, ReportCategory.HARASSMENT],
      details: '  worth trimming  ',
    });

    expect(result.report.reporter).toBe(REPORTER);
    expect(result.report.categories).toEqual([ReportCategory.SPAM, ReportCategory.HARASSMENT]);
    expect(result.report.details).toBe('  worth trimming  ');
  });
});

describe('a type with no subject provider', () => {
  /**
   * Stored, NOT refused — and with no outbox row at all rather than one a worker
   * would skip later, which would dead-letter a report that is not defective.
   * `received` and `delivery_failed` are different claims and must never merge.
   */
  it('is recorded locally with the reason, and enqueues nothing', async () => {
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.USER,
      reportedId: 'oxy-user-2',
      categories: [ReportCategory.HARASSMENT],
    });

    expect(result.outboxEventId).toBeUndefined();
    expect(result.report.localStatus).toBe('received');
    expect(result.report.localStatusReason).toContain('no moderation subject provider');
    expect(await db.select().from(moderationOutboxes)).toHaveLength(0);
  });
});

describe('a duplicate', () => {
  const input = {
    reporter: REPORTER,
    reportedType: ReportedType.AGENT,
    reportedId: 'agent-1',
    categories: [ReportCategory.SPAM],
  };

  it('throws DuplicateReportError carrying the ORIGINAL report', async () => {
    const first = await createReport(input);

    // The route answers 409 with this, so it must be the stored report and not
    // the one just attempted — a reporter who taps twice should learn Alia
    // already has it.
    await expect(createReport(input)).rejects.toBeInstanceOf(DuplicateReportError);
    try {
      await createReport(input);
    } catch (error) {
      expect((error as DuplicateReportError).existing.id).toBe(first.report.id);
    }
    expect(await db.select().from(reports)).toHaveLength(1);
  });

  it('does not queue a second delivery', async () => {
    await createReport(input);
    await expect(createReport(input)).rejects.toThrow();
    expect(await db.select().from(moderationOutboxes)).toHaveLength(1);
  });
});

describe('what intake refuses before it writes anything', () => {
  const valid = {
    reporter: REPORTER,
    reportedType: ReportedType.AGENT,
    reportedId: 'agent-1',
    categories: [ReportCategory.SPAM],
  };

  it('refuses a non-string identifier', async () => {
    await expect(
      createReport({ ...valid, reportedId: { $ne: null } as unknown as string }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await db.select().from(reports)).toHaveLength(0);
  });

  it('refuses an empty reporter', async () => {
    await expect(createReport({ ...valid, reporter: '   ' })).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a type that is not reportable', async () => {
    await expect(
      createReport({ ...valid, reportedType: 'spaceship' as ReportedType }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a report with no categories', async () => {
    await expect(createReport({ ...valid, categories: [] })).rejects.toBeInstanceOf(TypeError);
  });
});
