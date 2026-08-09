import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { createReport } from '../moderation/reportRepository';
import { moderationOutboxes, reports } from '../schema/moderation';

/**
 * Report intake against a REAL Postgres.
 *
 * Every property below is the server's, and a mocked drizzle handle can be made
 * to agree with any of them:
 *
 *  - a transaction that commits both writes or neither;
 *  - a unique index that actually refuses the second report;
 *  - `25P02`, which a mocked rejection cannot produce at all, and which is the
 *    entire reason `insertOrNullOnConflict` opens a savepoint.
 *
 * The `25P02` case is the one worth stating plainly: a mocked `insert` that
 * rejects leaves no aborted transaction behind, so the recovery read succeeds in
 * a mocked test and fails only in production.
 */

let db: ApiDatabase;

const REPORT = {
  id: 'report-1',
  reportedType: 'agent',
  reportedId: 'agent-1',
  reporter: 'oxy-user-1',
  categories: ['spam'],
  localStatus: 'queued',
} as const;

const EVENT = {
  id: 'report-1:report.submit',
  kind: 'report.submit',
  payload: { hello: 'world' },
  availableAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-02-01T00:00:00.000Z'),
} as const;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterEach(async () => {
  await db.execute(sql`truncate ${reports}, ${moderationOutboxes}`);
});

afterAll(async () => {
  await closePostgres();
});

describe('a report and its delivery event commit together', () => {
  it('writes both', async () => {
    const result = await createReport(db, REPORT, EVENT);

    expect(result.created).toBe(true);
    const events = await db.select().from(moderationOutboxes);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('pending');
  });

  it('writes NEITHER when the event insert fails', async () => {
    // `kind` violates its CHECK, so the second statement raises and the whole
    // transaction rolls back — including the report. Under Mongo this coupling
    // needed an explicit multi-document transaction; here it is the default, and
    // this test is what proves the report is not left behind.
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
      { ...EVENT, id: 'report-5:report.submit' },
    );

    // The unique key is (reporter, type, id) — two people may report one agent.
    expect(other.created).toBe(true);
    expect(await db.select().from(reports)).toHaveLength(2);
  });
});

describe('the categories constraints', () => {
  it('refuses a category outside the tuple', async () => {
    const bad = createReport(db, { ...REPORT, categories: ['not-a-category'] }, EVENT);
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
      { ...REPORT, categories: ['spam', 'harassment'] },
      EVENT,
    );
    expect(result.created).toBe(true);
  });
});

describe('the outbox enqueue is a genuine no-op on a repeat', () => {
  it('does not touch the row when the same event id arrives again', async () => {
    await createReport(db, REPORT, EVENT);
    const [before] = await db.execute<{ xmin: string; updated_at: Date }>(
      sql`select xmin::text, updated_at from ${moderationOutboxes} where id = ${EVENT.id}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    // Same deterministic event id, via a duplicate report.
    await createReport(db, { ...REPORT, id: 'report-6' }, EVENT);

    const [after] = await db.execute<{ xmin: string; updated_at: Date }>(
      sql`select xmin::text, updated_at from ${moderationOutboxes} where id = ${EVENT.id}`,
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
