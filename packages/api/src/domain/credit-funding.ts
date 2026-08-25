/**
 * Which balance funded a credit reservation.
 *
 * Recorded on the internal cost record so that "the customer was not charged for
 * this" and "nobody knows what this cost" stay different statements — ADR 0005,
 * *"Free and promotional usage is still cost-attributed internally"*.
 *
 * A LEAF module, per `db/schema/CONVENTIONS.md`: it imports nothing, so the
 * CHECK rendered from this tuple and the code that classifies a reservation read
 * the same words.
 *
 * ## What each value actually asserts, and what it does not
 *
 * `free_allowance` — the account's daily free allowance still held credits AFTER
 * the reservation was taken, so the reservation came out of it and nothing came
 * from the purchased bucket. `spendCreditsFreeFirst` spends free first, so a
 * non-zero remainder there is decisive.
 *
 * `paid_balance` — the free allowance was exhausted at that moment, so the
 * charge fell wholly or partly on the purchased-or-granted bucket.
 *
 * Two imprecisions, stated rather than hidden, because both are the kind that
 * would otherwise be discovered by somebody trusting the label:
 *
 *  1. **The exhausting request reads as `paid_balance`.** A reservation that
 *     takes the free balance to exactly zero leaves no remainder, and the
 *     statement returns only post-spend values, so it is indistinguishable from
 *     one that found the balance already empty. That is one request per account
 *     per allowance refresh, and it errs toward NOT claiming a turn was free.
 *  2. **`paid_balance` does not mean the customer paid.** `credits_paid` is one
 *     bucket holding both purchases and promotional grants — `routes/referrals.ts`
 *     credits a referral reward straight into it — so nothing at this layer can
 *     separate them. That separation is not missing by oversight: the Oxy
 *     contract already carries `purchasedBalance` and `promotionalBalance` as
 *     two fields (`payAsYouGoEntitlementSchema`), and adding a third Alia bucket
 *     now would be a second authority for a number ADR 0005 moves to Oxy.
 */

export const CREDIT_FUNDING_SOURCES = ['free_allowance', 'paid_balance'] as const;
export type CreditFundingSource = (typeof CREDIT_FUNDING_SOURCES)[number];

/**
 * Classify a reservation from the free balance LEFT once it was taken.
 *
 * The single expression the two imprecisions above describe, in the one place
 * they are described. It lives here rather than in `lib/credits-manager.ts`
 * because a second caller reads it off STORED columns: an agent session
 * persists `credit_reservation_initial_free_credits` but no funding source, and
 * a session reloaded from the queue has to reach the same verdict about the same
 * reservation as the request that took it — which it does, because this is the
 * only place either of them asks.
 *
 * @param freeCreditsRemaining `credits_free` AFTER the spend.
 */
export function fundingSourceOf(freeCreditsRemaining: number): CreditFundingSource {
  return freeCreditsRemaining > 0 ? 'free_allowance' : 'paid_balance';
}
