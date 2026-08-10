import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { setUpTestDatabase, type TestDatabaseHandle } from '../testDatabase';
import {
  applyDecisionToReport,
  closeUndeliverableReport,
  createReport,
  findReportById,
  findReportsByCaseId,
  markReportDeliveryFailed,
  markReportSubmitted,
} from '../moderation/reportRepository';
import { ReportCategory } from '../../domain/report.js';
import { moderationOutboxes, reports } from '../schema/moderation';

/**
 * Reports against a REAL Postgres.
 *
 * Every property below is the server's, and a mocked drizzle handle can be made
 * to agree with any of them:
 *
 *  - a transaction that commits both writes or neither;
 *  - a unique index that actually refuses the second report;
 *  - `25P02`, which a mocked rejection cannot produce at all, and which is the
 *    entire reason `insertOrNullOnConflict` opens a savepoint;
 *  - a revision guard whose `IS NULL` branch a mock would never exercise.
 *
 * The `25P02` case is the one worth stating plainly: a mocked `insert` that
 * rejects leaves no aborted transaction behind, so the recovery read succeeds in
 * a mocked test and fails only in production.
 */

let db: ApiDatabase;
let database: TestDatabaseHandle;

const REPORT = {
  id: 'report-1',
  reportedType: 'agent',
  reportedId: 'agent-1',
  reporter: 'oxy-user-1',
  categories: [ReportCategory.SPAM],
  localStatus: 'queued',
} as const;

/**
 * The event now carries only its identity — the repository sets `available_at`
 * and `expires_at` from the SERVER's clock.
 *
 * That removes a hazard this file used to manage by hand. `moderation_outboxes`
 * is an expiry target with `retentionSeconds: 0`, and these fixtures are
 * COMMITTED rather than transactional, so a fixture whose `expires_at` had
 * already passed was reapable by any expiry sweep between two reads here —
 * failing with `expected undefined to be '<xmin>'`, which names nothing about
 * the cause. The deadline is now always `now() + 90 days` by construction, so no
 * fixture in this file can be expired on arrival. It is "write fixture instants
 * relative to now" made structural rather than remembered.
 */
const EVENT = {
  eventId: 'report-1:report.submit',
  kind: 'report.submit',
  payload: { reportId: 'report-1' },
} as const;

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

describe('a report and its delivery event commit together', () => {
  it('writes both', async () => {
    const result = await createReport(db, REPORT, EVENT);

    expect(result.created).toBe(true);
    const events = await db.select().from(moderationOutboxes);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('pending');
  });

  /**
   * The rollback direction. Kept, and labelled: it is NOT the case that
   * discriminates an enqueue which escaped onto its own connection — a throw
   * propagates either way. That case lives in `moderationOutbox.pgdb.test.ts`,
   * where the enqueue SUCCEEDS and a later statement throws.
   */
  it('writes NEITHER when the event insert fails', async () => {
    // `kind` violates its CHECK, so the second statement raises and the whole
    // transaction rolls back — including the report.
    const bad = { ...EVENT, kind: 'not-a-kind' as 'report.submit' };

    await expect(createReport(db, REPORT, bad)).rejects.toThrow();

    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(0);
  });

  it('stores a report with no event when it is not deliverable', async () => {
    // A reported type with no subject provider is recorded LOCALLY, not refused.
    const result = await createReport(
      db,
      { ...REPORT, localStatus: 'received', localStatusReason: 'no provider' },
      null,
    );

    expect(result.created).toBe(true);
    expect(await db.select().from(moderationOutboxes)).toHaveLength(0);
    const [stored] = await db.select().from(reports);
    expect(stored?.localStatus).toBe('received');
  });
});

describe('a duplicate is answered with the EXISTING report, not a 500', () => {
  it('recovers after the unique violation — the 25P02 case', async () => {
    const first = await createReport(db, REPORT, EVENT);
    expect(first.created).toBe(true);

    // The whole point. Without the savepoint the INSERT's failure aborts the
    // transaction and this recovery read raises `25P02 current transaction is
    // aborted`, turning a friendly 409 into a 500.
    const second = await createReport(db, { ...REPORT, id: 'report-2' }, EVENT);

    expect(second.created).toBe(false);
    if (second.created) throw new Error('unreachable');
    // The ORIGINAL report, not the one just attempted.
    expect(second.existing.id).toBe('report-1');
    expect(await db.select().from(reports)).toHaveLength(1);
  });

  it('leaves the transaction usable, which is what the savepoint buys', async () => {
    await createReport(db, REPORT, EVENT);

    // A second duplicate, then a third: if the first recovery had poisoned the
    // connection rather than the transaction, this would fail differently.
    await createReport(db, { ...REPORT, id: 'report-3' }, EVENT);
    const third = await createReport(db, { ...REPORT, id: 'report-4' }, EVENT);

    expect(third.created).toBe(false);
    expect(await db.select().from(reports)).toHaveLength(1);
  });

  it('a DIFFERENT reporter on the same subject is not a duplicate', async () => {
    await createReport(db, REPORT, EVENT);

    const other = await createReport(
      db,
      { ...REPORT, id: 'report-5', reporter: 'oxy-user-2' },
      { ...EVENT, eventId: 'report-5:report.submit' },
    );

    // The unique key is (reporter, type, id) — two people may report one agent.
    expect(other.created).toBe(true);
    expect(await db.select().from(reports)).toHaveLength(2);
  });
});

describe('the categories constraints', () => {
  it('refuses a category outside the tuple', async () => {
    const bad = createReport(
      db,
      { ...REPORT, categories: ['not-a-category' as ReportCategory] },
      EVENT,
    );
    await expect(bad).rejects.toThrow();
  });

  it('refuses an EMPTY category list', async () => {
    // Containment permits `{}`, so membership alone would let this through —
    // which is why the cardinality CHECK is a separate constraint. Mongoose
    // expressed it as a custom validator that never ran on updateOne.
    const empty = createReport(db, { ...REPORT, categories: [] }, EVENT);
    await expect(empty).rejects.toThrow();
  });

  it('accepts several valid categories', async () => {
    const result = await createReport(
      db,
      { ...REPORT, categories: [ReportCategory.SPAM, ReportCategory.HARASSMENT] },
      EVENT,
    );
    expect(result.created).toBe(true);
  });
});

describe('the outbox enqueue is a genuine no-op on a repeat', () => {
  it('does not touch the row when the same event id arrives again', async () => {
    await createReport(db, REPORT, EVENT);
    const [before] = await db.execute<{ xmin: string; updated_at: Date }>(
      sql`select xmin::text, updated_at from ${moderationOutboxes} where id = ${EVENT.eventId}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    // Same deterministic event id, via a duplicate report.
    await createReport(db, { ...REPORT, id: 'report-6' }, EVENT);

    const [after] = await db.execute<{ xmin: string; updated_at: Date }>(
      sql`select xmin::text, updated_at from ${moderationOutboxes} where id = ${EVENT.eventId}`,
    );

    // `xmin` is the inserting transaction id: unchanged means no new tuple
    // version was written at all. `ON CONFLICT DO UPDATE` with identical values
    // would still bump both of these, which is what makes DO NOTHING the
    // structural answer rather than a stylistic one — the dispatcher may hold a
    // lease on this row while the repeat arrives.
    expect(after?.xmin).toBe(before?.xmin);
    expect(after?.updated_at).toEqual(before?.updated_at);
  });
});

describe('the delivery worker writes back onto the report', () => {
  it('records a submission and clears the previous failure', async () => {
    await createReport(db, REPORT, EVENT);
    await markReportDeliveryFailed(REPORT.id, 'CrowdSource was unreachable');

    await markReportSubmitted(REPORT.id, {
      crowdSourceReportId: 'csr_1',
      crowdSourceCaseId: 'case_1',
      crowdSourceMerged: true,
      contentSnapshotHash: 'sha256:abc',
    });

    const stored = await findReportById(REPORT.id);
    expect(stored?.localStatus).toBe('submitted');
    expect(stored?.crowdSourceCaseId).toBe('case_1');
    expect(stored?.crowdSourceMerged).toBe(true);
    // Mongo spelled this `$unset`; here absence is NULL. If it stayed set, an
    // operational sweep would report a delivered report as still failing.
    expect(stored?.lastDeliveryError).toBeNull();
    expect(stored?.submittedAt).toBeInstanceOf(Date);
  });

  it('closes a report whose subject is gone', async () => {
    await createReport(db, REPORT, EVENT);
    await closeUndeliverableReport(REPORT.id, 'The content is no longer available');

    const stored = await findReportById(REPORT.id);
    expect(stored?.localStatus).toBe('closed');
    expect(stored?.localStatusReason).toBe('The content is no longer available');
  });

  it('answers null for a report that does not exist', async () => {
    expect(await findReportById('no-such-report')).toBeNull();
  });
});

describe('applying a decision, with the revision guard', () => {
  const decision = {
    status: 'resolved',
    localStatus: 'closed',
    decisionId: 'dec_1',
    decisionRevision: 2,
    decisionOutcome: 'violation',
    decisionStatus: 'final',
    decidedAt: new Date('2026-03-01T00:00:00.000Z'),
    enforcedAction: 'restrict',
  } as const;

  /**
   * The FIRST decision is the case the `IS NULL` branch exists for, and the one
   * a mock would never catch. `decision_revision` is still unset, and in SQL
   * `NULL <= 2` is NULL, which a WHERE treats as false — so without the explicit
   * `IS NULL` this update would match nothing and every first decision would be
   * silently dropped while the function reported `false`.
   */
  it('writes the first decision, where the column is still NULL', async () => {
    await createReport(db, REPORT, EVENT);

    expect(await applyDecisionToReport(REPORT.id, decision)).toBe(true);

    const stored = await findReportById(REPORT.id);
    expect(stored?.decisionRevision).toBe(2);
    expect(stored?.decisionStatus).toBe('final');
    expect(stored?.enforcedAction).toBe('restrict');
    // Written only alongside an action, so its presence tracks the action's.
    expect(stored?.enforcedAt).toBeInstanceOf(Date);
    expect(stored?.decidedAt).toEqual(decision.decidedAt);
  });

  it('accepts a LATER revision', async () => {
    await createReport(db, REPORT, EVENT);
    await applyDecisionToReport(REPORT.id, decision);

    expect(
      await applyDecisionToReport(REPORT.id, { ...decision, decisionRevision: 3 }),
    ).toBe(true);
    expect((await findReportById(REPORT.id))?.decisionRevision).toBe(3);
  });

  it('REFUSES an older revision, and leaves the current answer alone', async () => {
    await createReport(db, REPORT, EVENT);
    await applyDecisionToReport(REPORT.id, { ...decision, decisionRevision: 5 });

    // §10.9 retries for 24 hours and a correction can overlap the decision it
    // supersedes, so an older revision landing last is ordinary rather than
    // exceptional. The database refuses it; no read-then-write in the worker.
    expect(
      await applyDecisionToReport(REPORT.id, {
        ...decision,
        decisionRevision: 4,
        decisionOutcome: 'no_violation',
      }),
    ).toBe(false);

    const stored = await findReportById(REPORT.id);
    expect(stored?.decisionRevision).toBe(5);
    expect(stored?.decisionOutcome).toBe('violation');
  });

  it('leaves enforcedAction unset when no action was taken', async () => {
    await createReport(db, REPORT, EVENT);
    const { enforcedAction: _omitted, ...withoutAction } = decision;

    expect(await applyDecisionToReport(REPORT.id, withoutAction)).toBe(true);

    const stored = await findReportById(REPORT.id);
    // Not `'none'`: nothing was enforced, and an explicit `none` is a DIFFERENT
    // claim that only the enforcement plan may make.
    expect(stored?.enforcedAction).toBeNull();
    expect(stored?.enforcedAt).toBeNull();
  });

  it('refuses an enforced action outside the tuple', async () => {
    await createReport(db, REPORT, EVENT);
    // Alia's own closed set, so unlike `decisionStatus` it IS CHECKed.
    await expect(
      applyDecisionToReport(REPORT.id, { ...decision, enforcedAction: 'delete_everything' }),
    ).rejects.toThrow();
  });

  /**
   * `decisionStatus` and `decisionOutcome` are deliberately UNCHECKED: both come
   * off the wire and §10.11 makes decisions loose on purpose, so a value a newer
   * CrowdSource introduces must be storable rather than dead-lettered.
   */
  it('stores a decision status this deployment has never seen', async () => {
    await createReport(db, REPORT, EVENT);

    expect(
      await applyDecisionToReport(REPORT.id, {
        ...decision,
        decisionStatus: 'a_status_from_a_newer_crowdsource',
        decisionOutcome: 'an_outcome_from_a_newer_crowdsource',
      }),
    ).toBe(true);

    const stored = await findReportById(REPORT.id);
    expect(stored?.decisionStatus).toBe('a_status_from_a_newer_crowdsource');
  });
});

describe('the reports of one case', () => {
  it('returns every report on the case, oldest first', async () => {
    await createReport(db, REPORT, EVENT);
    await createReport(
      db,
      { ...REPORT, id: 'report-b', reporter: 'oxy-user-2' },
      { ...EVENT, eventId: 'report-b:report.submit' },
    );
    for (const id of ['report-1', 'report-b']) {
      await markReportSubmitted(id, {
        crowdSourceReportId: `csr_${id}`,
        crowdSourceCaseId: 'case_shared',
        crowdSourceMerged: true,
        contentSnapshotHash: 'sha256:abc',
      });
    }

    const found = await findReportsByCaseId('case_shared');
    expect(found.map((r) => r.id)).toEqual(['report-1', 'report-b']);
  });

  /**
   * Empty is a real answer the decision worker acts on — it defers rather than
   * dead-letters, because the webhook can outrun the response that carried the
   * case id back. It must not be an error.
   */
  it('returns nothing for a case no report is linked to', async () => {
    await createReport(db, REPORT, EVENT);
    expect(await findReportsByCaseId('case_nobody_reported')).toHaveLength(0);
  });
});
