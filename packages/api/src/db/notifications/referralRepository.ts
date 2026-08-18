/**
 * Referrals and their redemptions, on Postgres.
 *
 * ## The redemption race, and why the order of operations changes
 *
 * `routes/referrals.ts` granted credits to BOTH parties and only afterwards set
 * the redeemer's `referredBy`. The "have you already redeemed?" guard was
 * therefore a read-then-write whose write lands after the money moves: two
 * concurrent redemptions by one account both see no `referredBy`, both proceed,
 * and both pay out. Mongo had no constraint that could stop it — a `$push` into
 * a sub-document array cannot be made unique.
 *
 * `UNIQUE(referred_user_id)` on `referral_redemptions` makes it structural. But
 * the constraint alone does not fix the bug: keeping the original order would
 * pay twice and THEN fail the insert, which is strictly worse than today because
 * the money has already moved. So the claim is taken FIRST, in the same
 * transaction that records the referral, and the caller grants credits only if
 * the claim succeeded.
 *
 * **This is a deliberate behaviour change**: the guard moves from a racy read to
 * the database, and the money follows the claim rather than preceding it. The
 * failure mode it replaces is a double payout; the failure mode it introduces is
 * a recorded redemption whose credit grant failed — visible, bounded, and the
 * direction anybody would choose.
 *
 * ## The credit grant is not in this transaction
 *
 * It could not be while `user_credits` was Mongoose — a Mongo session cannot
 * enlist a Postgres write — and that is why `redeemReferral` returns an outcome
 * and leaves the money to the caller instead of taking a callback. `user_credits`
 * is now a Postgres table (`db/schema/billing.ts`), so the split is a CHOICE
 * rather than a constraint, and folding the grant into this transaction is a
 * behaviour change somebody should make deliberately rather than notice here.
 * Until then the failure mode is unchanged: a recorded redemption whose credit
 * grant failed — visible, bounded, and not a double payout.
 *
 * ## The counters stay stored, and are now also derivable
 *
 * `total_credits_earned` and `total_referrals` were maintained with `$inc` and
 * are kept as stored columns, a faithful port. They are now DERIVABLE from
 * `referral_redemptions`, so a repair is possible where it was not — but the two
 * sources must never be summed together.
 */

import { and, eq, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import crypto from 'crypto';
import type { ApiDatabase } from '../index';
import { referralRedemptions, referrals } from '../schema/notifications';

export type ReferralRow = typeof referrals.$inferSelect;
export type ReferralRedemptionRow = typeof referralRedemptions.$inferSelect;

/** How many times to retry an invite-code collision before giving up. */
const INVITE_CODE_ATTEMPTS = 3;

function generateInviteCode(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
}

/**
 * This account's referral row, creating it on first access.
 *
 * `id` IS the Oxy account id — `referrals` has no generated default, so the
 * caller supplies it and the row is unique by construction.
 *
 * The conflict target is `referrals.id` EXPLICITLY, so an `invite_code`
 * collision RAISES and is handled by the retry below rather than being swallowed
 * into an empty `RETURNING`.
 *
 * **This is legibility, not correctness, and it was measured rather than
 * assumed.** Mutating the target away to a bare `onConflictDoNothing()` survived
 * the whole suite, and it should have: a swallowed invite-code collision returns
 * no row, the read by id then finds nothing, and the loop retries with a fresh
 * code — arriving at the same place by a different route. What the explicit
 * target buys is that the two situations the loop can be in ("the row already
 * existed" and "the code collided") stay distinguishable, so the `continue`
 * below means only what its comment says. No test distinguishes them, and
 * inventing one would mean adding an injectable code generator to production
 * for the sake of the test.
 */
export async function getOrCreateReferral(db: ApiDatabase, userId: string): Promise<ReferralRow> {
  for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt++) {
    try {
      const [created] = await db
        .insert(referrals)
        .values({ id: userId, inviteCode: generateInviteCode() })
        .onConflictDoNothing({ target: referrals.id })
        .returning();

      if (created) return created;

      // The row already existed — the empty `RETURNING` set IS that answer.
      const existing = await findReferralById(db, userId);
      if (existing) return existing;

      // Deleted between the insert and the read. Try again.
      continue;
    } catch (error: unknown) {
      // Only an invite-code collision is retryable; anything else propagates.
      if (isUniqueViolation(error) && attempt < INVITE_CODE_ATTEMPTS - 1) continue;
      throw error;
    }
  }

  throw new Error(`could not allocate a unique invite code for ${userId}`);
}

export async function findReferralById(
  db: ApiDatabase,
  userId: string,
): Promise<ReferralRow | null> {
  const [row] = await db.select().from(referrals).where(eq(referrals.id, userId)).limit(1);
  return row ?? null;
}

export async function findReferralByInviteCode(
  db: ApiDatabase,
  inviteCode: string,
): Promise<ReferralRow | null> {
  const [row] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.inviteCode, inviteCode))
    .limit(1);

  return row ?? null;
}

/**
 * The outcome of a redemption attempt.
 *
 * A STRING discriminant rather than a boolean: without `strictNullChecks`,
 * TypeScript does not narrow a union on a boolean-literal discriminant, so
 * `outcome: 'claimed' | 'already_redeemed'` is what makes the caller's branch
 * type-safe.
 */
export type RedeemOutcome =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'already_redeemed' };

export interface RedeemInput {
  readonly referrerId: string;
  readonly referredUserId: string;
  readonly email?: string | undefined;
  readonly creditsAwarded: number;
}

/**
 * Claim a redemption, record it, and advance the referrer's counters — or
 * report that this account was already referred.
 *
 * ONE transaction, and the claim is the first statement in it, so a concurrent
 * duplicate loses at the unique index rather than at a read the winner had not
 * yet written. The caller grants credits only on `claimed`.
 *
 * `ON CONFLICT DO NOTHING … RETURNING` rather than catching a violation: the
 * empty result set IS the answer, no statement fails, and so the transaction is
 * never aborted. Catching would need a SAVEPOINT — in Postgres a failed
 * statement aborts the whole transaction, and the counter updates below would
 * then fail with `25P02`.
 */
export async function redeemReferral(db: ApiDatabase, input: RedeemInput): Promise<RedeemOutcome> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(referralRedemptions)
      .values({
        referralId: input.referrerId,
        referredUserId: input.referredUserId,
        email: input.email ?? null,
        creditedAt: new Date(),
        creditsAwarded: input.creditsAwarded,
      })
      .onConflictDoNothing({ target: referralRedemptions.referredUserId })
      .returning({ id: referralRedemptions.id });

    if (!claimed) return { outcome: 'already_redeemed' };

    // The redeemer's own row records who referred them. Set ONLY when it is
    // still unset, so a row that somehow already carries one is not rewritten.
    await tx
      .update(referrals)
      .set({ referredBy: input.referrerId })
      .where(and(eq(referrals.id, input.referredUserId), sql`${referrals.referredBy} is null`));

    // The counters are incremented BY POSTGRES. Reading them into JS and
    // writing back would be a lost update under two concurrent redemptions of
    // the same referrer's code — which is legitimate and concurrent, unlike the
    // duplicate the unique above rejects.
    await tx
      .update(referrals)
      .set({
        totalCreditsEarned: sql`${referrals.totalCreditsEarned} + ${input.creditsAwarded}`,
        totalReferrals: sql`${referrals.totalReferrals} + 1`,
      })
      .where(eq(referrals.id, input.referrerId));

    return { outcome: 'claimed' };
  });
}

/** This account's redemption history, oldest first — the order it was granted in. */
export async function listRedemptions(
  db: ApiDatabase,
  referrerId: string,
): Promise<ReferralRedemptionRow[]> {
  return db
    .select()
    .from(referralRedemptions)
    .where(eq(referralRedemptions.referralId, referrerId))
    .orderBy(referralRedemptions.creditedAt, referralRedemptions.id);
}
