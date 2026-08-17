import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { transactions } from '../schema/billing';

/**
 * A settled receipt cannot be rewritten — epic #139 workstream 12, ADR 0005
 * *"A plan change can never rewrite a historical financial receipt"*.
 *
 * ## Why this file is `.pgdb` and could not be anything else
 *
 * The invariant is a TRIGGER (migration `0023_append_only_receipts.sql`). There
 * is no mocked counterpart: a fake `db` accepts an UPDATE that the server
 * refuses, so a unit test asserting "the repository exports no update" measures
 * the repository's exports and says nothing about what the database permits. The
 * whole point of moving this from convention to constraint is that the next
 * function anybody writes is bound by it too, and only the server can hold that.
 *
 * ## What the ABSENCE of this would look like
 *
 * Exactly like today, which is why it is worth stating: nothing in the package
 * updates or deletes a transaction (`docs/migration/inventories/billing-paths.json`
 * lists every writer of all seven billing tables and `transactions` has one, an
 * insert). So a behavioural suite over the existing code is green with the
 * trigger and green without it. These assertions issue the write DIRECTLY, which
 * is the only way to tell the two states apart.
 *
 * Mutation-tested by commenting out the `CREATE TRIGGER` statement in `0023`:
 * both refusal cases go red and the "correct forward" case stays green.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function receipt(id: string, overrides: Partial<typeof transactions.$inferInsert> = {}) {
  return {
    id,
    oxyUserId: 'immutable-receipts-user',
    type: 'subscription_payment' as const,
    amount: 2500,
    credits: 1000,
    status: 'completed' as const,
    ...overrides,
  };
}

describe('transactions is append-only at the DATABASE (#139 ws12)', () => {
  it('accepts the insert, so the refusals below are about the write and not the row', async () => {
    // The positive control. Without it a broken fixture would make every
    // "was refused" assertion pass for the wrong reason.
    await db.insert(transactions).values(receipt('txn-immutable-seed'));

    const [row] = await db
      .select({ amount: transactions.amount, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.id, 'txn-immutable-seed'));

    expect(row).toEqual({ amount: 2500, status: 'completed' });
  });

  it('refuses an UPDATE, by name, and leaves the amount where it was', async () => {
    await db.insert(transactions).values(receipt('txn-immutable-update'));

    const rewrite = db
      .update(transactions)
      .set({ amount: 1 })
      .where(eq(transactions.id, 'txn-immutable-update'));

    const error = await rewrite.then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error, 'the UPDATE was allowed to rewrite a settled receipt').not.toBeNull();
    // By CONSTRAINT NAME, never a message regex: drizzle wraps the failure so
    // the driver's fields live on `cause`, and a name check cannot be satisfied
    // by some other error that happens to be raised on this table.
    expect(constraintNameOf(error)).toBe('transactions_append_only');

    const [row] = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.id, 'txn-immutable-update'));
    expect(row?.amount).toBe(2500);
  });

  it('refuses a DELETE too, so a rewrite cannot be spelled as remove-and-reinsert', async () => {
    // The half that is easy to leave out. A trigger on UPDATE alone stops the
    // in-place edit and permits the identical outcome one statement longer.
    await db.insert(transactions).values(receipt('txn-immutable-delete'));

    const error = await db
      .delete(transactions)
      .where(eq(transactions.id, 'txn-immutable-delete'))
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error, 'the DELETE was allowed to remove a settled receipt').not.toBeNull();
    expect(constraintNameOf(error)).toBe('transactions_append_only');

    const [row] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.id, 'txn-immutable-delete'));
    expect(row?.id).toBe('txn-immutable-delete');
  });

  it('still lets a correction be recorded FORWARD, which is what makes the refusal usable', async () => {
    // A constraint whose cheapest green is "stop recording corrections" would be
    // the wrong invariant. `refund` is already in TRANSACTION_TYPES for this.
    await db.insert(transactions).values(
      receipt('txn-immutable-charge', { metadata: { dedup: 'immutable-charge' } }),
    );
    await db.insert(transactions).values(
      receipt('txn-immutable-refund', {
        type: 'refund',
        amount: -2500,
        credits: -1000,
        metadata: { dedup: 'immutable-refund', corrects: 'txn-immutable-charge' },
      }),
    );

    const [{ net }] = await db
      .select({ net: sql<number>`coalesce(sum(${transactions.amount}), 0)::bigint::text::int` })
      .from(transactions)
      .where(sql`${transactions.id} in ('txn-immutable-charge', 'txn-immutable-refund')`);

    // Two rows, netting to nothing — the correction happened and the original is
    // still there to be audited, which is the whole shape ADR 0005 asks for.
    expect(net).toBe(0);
  });

  it('the trigger is on both events and fires per row, read back from the catalogue', async () => {
    // The behavioural cases above would also pass if some unrelated rule refused
    // the writes. This names the object, so a red run says what is missing.
    const rows = await db.execute<{ tgname: string; events: string; level: string }>(sql`
      select t.tgname,
             case when (t.tgtype & 16) > 0 then 'update' else '' end ||
             case when (t.tgtype & 8) > 0 then ' delete' else '' end as events,
             case when (t.tgtype & 1) > 0 then 'row' else 'statement' end as level
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where c.relname = 'transactions' and not t.tgisinternal
    `);

    expect(rows.map((r) => r.tgname)).toEqual(['transactions_append_only']);
    expect(rows[0].events).toBe('update delete');
    expect(rows[0].level).toBe('row');
  });
});
