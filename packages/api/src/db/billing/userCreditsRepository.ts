/**
 * One account's credit balance, on Postgres.
 *
 * The table is keyed by the OXY ACCOUNT ID (`id`), not by a row identity — Mongo
 * declared `_id: { type: String }` and wrote the account id into it. The
 * `credits` sub-document became `credits_*` columns.
 *
 * ## Every balance change is ONE statement, and that is the point
 *
 * The Mongoose model expressed "spend free first, then paid" as an aggregation-
 * pipeline update with `$cond`, guarded by `$expr` on the total. It is
 * reproduced here as arithmetic in the `SET` clause with the same guard in the
 * `WHERE`, so the read and the write are still one atomic statement:
 *
 *     credits_free = greatest(credits_free - $n, 0)
 *     credits_paid = credits_paid - greatest($n - credits_free, 0)
 *     WHERE credits_free + credits_paid >= $n
 *
 * Both branches of the source's `$cond` fall out of that: when `free >= n` the
 * second `greatest` is 0 and `paid` is untouched; when it is not, `free` goes to
 * 0 and `paid` absorbs the remainder. Postgres evaluates every `SET` expression
 * against the row as it was BEFORE the statement, so the `credits_free` read by
 * the second line is the old value — which is exactly what the `$cond` did.
 *
 * The empty RETURNING set IS "insufficient balance, or no such account", the
 * same discrimination the source got from a null `findOneAndUpdate`. A real
 * failure still propagates as an exception.
 *
 * ## `deductCredits` spent PAID first; `reserveCredits` spends FREE first
 *
 * Not a mistake in either: they are different operations and the source ordered
 * them differently. `spendCreditsFreeFirst` and `spendCreditsPaidFirst` keep
 * both, named so the difference cannot be collapsed by accident.
 */

import { eq, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { userCredits } from '../schema/billing';

export type UserCreditsRow = typeof userCredits.$inferSelect;

/** Mongoose's schema defaults, which the upsert has to supply explicitly. */
const DEFAULT_FREE_CREDITS = 300;

/**
 * The account's balance row, created with the default free allowance if absent.
 *
 * `ON CONFLICT DO UPDATE SET id = id` rather than `DO NOTHING`: `DO NOTHING`
 * returns no row when one already exists, which would need a second read and
 * make "created" and "existed" two different code paths. This is one statement
 * that always returns the row, matching `findByIdAndUpdate(..., { upsert: true,
 * returnDocument: 'after' })`.
 */
export async function getOrCreateUserCredits(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserCreditsRow> {
  const [row] = await db
    .insert(userCredits)
    .values({
      id: oxyUserId,
      creditsFree: DEFAULT_FREE_CREDITS,
      creditsFreeLimit: DEFAULT_FREE_CREDITS,
      creditsDailyRefresh: DEFAULT_FREE_CREDITS,
      creditsLastRefresh: new Date(),
      creditsPaid: 0,
    })
    .onConflictDoUpdate({ target: userCredits.id, set: { id: oxyUserId } })
    .returning();
  if (!row) throw new Error('user credits upsert returned no row');
  return row;
}

export async function findUserCredits(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserCreditsRow | null> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, oxyUserId));
  return row ?? null;
}

/** Spend `amount`, taking it from the FREE balance first. `null` if it will not cover. */
export async function spendCreditsFreeFirst(
  db: ApiDatabase,
  oxyUserId: string,
  amount: number,
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .update(userCredits)
    .set({
      creditsFree: sql`greatest(${userCredits.creditsFree} - ${amount}, 0)`,
      creditsPaid: sql`${userCredits.creditsPaid} - greatest(${amount} - ${userCredits.creditsFree}, 0)`,
    })
    .where(
      sql`${userCredits.id} = ${oxyUserId} and ${userCredits.creditsFree} + ${userCredits.creditsPaid} >= ${amount}`,
    )
    .returning();
  return row ?? null;
}

/**
 * Spend `amount`, taking it from the PAID balance first. `null` if it will not
 * cover.
 *
 * The source's `deductCredits` chose its branch from an in-memory read of
 * `this.credits.paid` and only then issued a guarded update — so a concurrent
 * deduction between the read and the write made the branch wrong, and the guard
 * then returned `false` for a deduction that should have succeeded. One
 * statement removes the window; the arithmetic is the same.
 */
export async function spendCreditsPaidFirst(
  db: ApiDatabase,
  oxyUserId: string,
  amount: number,
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .update(userCredits)
    .set({
      creditsPaid: sql`greatest(${userCredits.creditsPaid} - ${amount}, 0)`,
      creditsFree: sql`${userCredits.creditsFree} - greatest(${amount} - ${userCredits.creditsPaid}, 0)`,
    })
    .where(
      sql`${userCredits.id} = ${oxyUserId} and ${userCredits.creditsFree} + ${userCredits.creditsPaid} >= ${amount}`,
    )
    .returning();
  return row ?? null;
}

/**
 * Add credits to one balance. `null` if there is no such account.
 *
 * The arithmetic stays in the database: reading into JS and writing back would
 * be a lost update under two concurrent grants.
 */
export async function addCredits(
  db: ApiDatabase,
  oxyUserId: string,
  amount: number,
  type: 'free' | 'paid' = 'paid',
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .update(userCredits)
    .set(
      type === 'free'
        ? { creditsFree: sql`${userCredits.creditsFree} + ${amount}` }
        : { creditsPaid: sql`${userCredits.creditsPaid} + ${amount}` },
    )
    .where(eq(userCredits.id, oxyUserId))
    .returning();
  return row ?? null;
}

/** Set both balances to zero. `null` if there is no such account. */
export async function zeroCredits(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .update(userCredits)
    .set({ creditsFree: 0, creditsPaid: 0 })
    .where(eq(userCredits.id, oxyUserId))
    .returning();
  return row ?? null;
}

/**
 * Top the free allowance back up if a day has passed, as ONE compare-and-set.
 *
 * `credits_last_refresh` is the concurrency control, not a diagnostic: the
 * source read the stored instant, decided 24 hours had passed, then updated
 * `WHERE lastRefresh = <the value it read>`. Here the comparison is against the
 * SERVER's `now()` inside the same statement, so two tasks refreshing at once
 * cannot both win and the allowance is granted exactly once.
 *
 * Returns the row whether or not it refreshed — callers want the current balance
 * either way, and `null` means the account does not exist.
 */
export async function refreshFreeCreditsIfDue(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserCreditsRow | null> {
  const [refreshed] = await db
    .update(userCredits)
    .set({
      creditsFree: sql`${userCredits.creditsFreeLimit}`,
      creditsLastRefresh: sql`now()`,
    })
    .where(
      sql`${userCredits.id} = ${oxyUserId}
        and ${userCredits.creditsLastRefresh} <= now() - interval '24 hours'`,
    )
    .returning();
  if (refreshed) return refreshed;
  // Not due (or no such account) — the read tells the two apart.
  return findUserCredits(db, oxyUserId);
}

/** Attach a Stripe customer id to a balance row. */
export async function setStripeCustomerId(
  db: ApiDatabase,
  oxyUserId: string,
  stripeCustomerId: string,
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .update(userCredits)
    .set({ stripeCustomerId })
    .where(eq(userCredits.id, oxyUserId))
    .returning();
  return row ?? null;
}

/** The balance row for a Stripe customer, if one is linked. */
export async function findUserCreditsByStripeCustomerId(
  db: ApiDatabase,
  stripeCustomerId: string,
): Promise<UserCreditsRow | null> {
  const [row] = await db
    .select()
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, stripeCustomerId));
  return row ?? null;
}
