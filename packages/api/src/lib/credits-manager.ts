import { getDb } from '../db/index.js';
import {
  addCredits as addCreditsToBalance,
  findUserCredits,
  spendCreditsFreeFirst,
  zeroCredits,
  type UserCreditsRow,
} from '../db/billing/userCreditsRepository.js';
import { log } from './logger.js';
import { findCatalogueModel } from './models/catalogue.js';
import { fundingSourceOf, type CreditFundingSource } from '../domain/credit-funding.js';

/**
 * Credits Manager
 *
 * A turn is charged by what it COST (ADR 0012): the metered token units times
 * the model's unit prices from Oxy's catalogue — the same price list Oxy
 * settles against — converted at {@link CREDITS_CONFIG.USD_PER_CREDIT}. Plans
 * differ only by how many credits they grant; no model is priced by a
 * multiplier Alia invented.
 */

export interface CreditUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  systemPromptTokens?: number; // Tokens from our system prompt (not charged to user)
  /**
   * The output tokens the model spent THINKING, as the provider reported them.
   *
   * Already inside {@link completionTokens} — a breakdown, not extra volume —
   * and priced at the model's output price with the rest of the output. Kept
   * for the usage log.
   */
  reasoningTokens?: number;
}

export interface CreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
  /**
   * Which balance funded this reservation, carried to whatever cost record the
   * request produces. ADR 0005: free and promotional usage is still
   * cost-attributed internally, so a settlement must be able to say the customer
   * was not billed WITHOUT that meaning nobody measured the cost.
   *
   * `domain/credit-funding.ts` states exactly what each value asserts and the
   * two things it deliberately does not.
   */
  grantKind: CreditFundingSource;
}

/**
 * Configuration for credit calculations
 */
export const CREDITS_CONFIG = {
  /** What one credit is worth, in USD of inference cost. 1000 credits = $1. */
  USD_PER_CREDIT: 0.001,

  /**
   * Tokens per credit, for a charge with no model to price it: a caller that
   * prices its own work (images, audio, deep research, agent runs) and settles
   * at this base rate deliberately, and a model whose catalogue entry carries
   * no token prices.
   */
  TOKENS_PER_CREDIT: 1000,

  // Minimum credits to charge per request
  MIN_CREDITS_PER_REQUEST: 1,

  // Initial credits to reserve (will be adjusted based on actual usage)
  INITIAL_RESERVATION: 1,
};

/** Credits for a USD cost, rounded up and floored at the per-request minimum. */
export function creditsForCost(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  // Rounded to 1e-9 first so float noise (0.1 + 0.2) never adds a credit.
  const exact = Math.round((usd / CREDITS_CONFIG.USD_PER_CREDIT) * 1e9) / 1e9;
  return Math.max(Math.ceil(exact), CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
}

/** The base-rate charge for a token count nothing prices. */
function baseRateCredits(tokens: number): number {
  return Math.max(Math.ceil(tokens / CREDITS_CONFIG.TOKENS_PER_CREDIT), CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
}

/**
 * What a turn costs in credits.
 *
 * - `modelId` absent: the caller priced its own work — base rate.
 * - a catalogue model with token prices: input × input price + output × output
 *   price, in USD, converted to credits. The system prompt Alia adds is Alia's
 *   cost, not the person's, so it is taken off the input first. Reasoning
 *   tokens are output tokens and are already inside `completionTokens`.
 * - a model the catalogue no longer prices: base rate, logged. The model was
 *   validated when the turn started; a price that vanished mid-turn is not a
 *   reason to leave the turn unbilled or to refuse it after the fact.
 */
export async function calculateCredits(usage: CreditUsage, modelId?: string): Promise<number> {
  const systemTokens = Math.max(0, usage.systemPromptTokens || 0);
  const totalTokens = Math.max(0, usage.totalTokens || usage.promptTokens + usage.completionTokens);
  if (totalTokens === 0) return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;

  if (modelId === undefined) return baseRateCredits(Math.max(0, totalTokens - systemTokens));

  const model = await findCatalogueModel(modelId).catch((err: unknown) => {
    log.credits.warn({ err, modelId }, 'Catalogue unavailable while pricing a turn; charging the base rate');
    return null;
  });
  if (model?.pricing == null) {
    log.credits.warn({ modelId }, 'No catalogue price for this model; charging the base rate');
    return baseRateCredits(Math.max(0, totalTokens - systemTokens));
  }

  const inputTokens = Math.max(0, (usage.promptTokens || 0) - systemTokens);
  const outputTokens = Math.max(0, usage.completionTokens || 0);
  const usd =
    (inputTokens * Number(model.pricing.inputPerMTok)) / 1_000_000 +
    (outputTokens * Number(model.pricing.outputPerMTok)) / 1_000_000;
  const credits = creditsForCost(usd);
  log.credits.info({ modelId, inputTokens, outputTokens, systemTokens, usd, credits }, 'Priced turn');
  return credits;
}

/**
 * Reserve initial credits for a request
 * Returns null if insufficient credits
 */
export async function reserveCredits(
  userId: string,
  amount: number = CREDITS_CONFIG.INITIAL_RESERVATION
): Promise<CreditReservation | null> {
  try {
    /**
     * Deduct from free credits first, then paid — one guarded statement, as the
     * `$cond` pipeline was. A null result means the balance will not cover it,
     * or the account does not exist.
     *
     * The source also `$set` a `credits.lastUsed`. That path is not in the
     * Mongoose schema, so `strict` dropped it on every write and it has never
     * been stored; there is no column for it and none is added.
     */
    const reserveResult = await spendCreditsFreeFirst(getDb(), userId, amount);

    if (!reserveResult) {
      log.credits.info({ userId }, 'Insufficient credits for user');
      return null;
    }

    /**
     * The funding source, decided by the one value the statement can report.
     *
     * `spendCreditsFreeFirst` takes the free allowance first, so a NON-ZERO
     * remainder proves the whole reservation came out of it and the paid bucket
     * was untouched. Zero does not prove the opposite — the allowance may have
     * been emptied by exactly this reservation — and that is the documented
     * imprecision in `domain/credit-funding.ts`, which errs toward not claiming
     * a turn was free.
     *
     * Derived here rather than in the repository because it is an ATTRIBUTION
     * decision, not a balance one, and the repository's whole contract is that
     * each balance change is one statement returning the row it wrote.
     */
    const grantKind: CreditFundingSource = fundingSourceOf(reserveResult.creditsFree);

    log.credits.info({ amount, userId, grantKind }, 'Reserved credits for user');
    log.credits.info({ free: reserveResult.creditsFree, paid: reserveResult.creditsPaid }, 'Remaining credits');

    return {
      userId,
      creditsReserved: amount,
      initialFreeCredits: reserveResult.creditsFree,
      initialPaidCredits: reserveResult.creditsPaid,
      grantKind,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error reserving credits');
    throw error;
  }
}

/**
 * Shared credit adjustment logic used by both finalizeCredits and finalizeFixedCredits.
 * Handles refund-if-over or charge-if-under relative to the initial reservation.
 */
async function _adjustReservation(
  reservation: CreditReservation,
  actualCreditsNeeded: number,
  label: string,
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;
  log.credits.info({ userId: reservation.userId, reserved: reservation.creditsReserved, actualNeeded: actualCreditsNeeded, creditAdjustment }, `Finalizing ${label}`);

  // Each branch resolves the up-to-date doc in a single round trip; a null result
  // is the not-found signal (no separate existence read needed).
  let updatedCredits: UserCreditsRow | null;

  if (creditAdjustment > 0) {
    // To the bucket that funded the reservation — see `refundBucket`.
    const bucket = refundBucket(reservation);
    updatedCredits = await addCreditsToBalance(getDb(), reservation.userId, creditAdjustment, bucket);
    if (updatedCredits) {
      log.credits.info({ refunded: creditAdjustment, bucket }, `Refunded ${label} credits`);
    }
  } else if (creditAdjustment < 0) {
    const additionalCredits = Math.abs(creditAdjustment);

    updatedCredits = await spendCreditsFreeFirst(getDb(), reservation.userId, additionalCredits);

    if (!updatedCredits) {
      // Guard matched nothing: either insufficient balance (user exists) or the
      // user is gone. Zero-out succeeds for the former, returns null for the latter.
      updatedCredits = await zeroCredits(getDb(), reservation.userId);
      if (updatedCredits) {
        log.credits.warn(`Insufficient credits for additional ${label} charge, set to 0`);
      }
    } else {
      log.credits.info({ additionalCredits }, `Charged additional ${label} credits`);
    }
  } else {
    // No adjustment needed: read current balance to report remaining credits.
    updatedCredits = await findUserCredits(getDb(), reservation.userId);
  }

  if (!updatedCredits) {
    throw new Error('User credits not found');
  }

  const totalRemaining = updatedCredits.creditsFree + updatedCredits.creditsPaid;
  log.credits.info({ free: updatedCredits.creditsFree, paid: updatedCredits.creditsPaid, total: totalRemaining }, `Final ${label} credits`);

  return {
    creditsCharged: actualCreditsNeeded,
    creditsRemaining: totalRemaining,
  };
}

/**
 * Settle a reservation against what the turn actually cost.
 * If actual usage > reserved: deduct more
 * If actual usage < reserved: refund difference
 *
 * @param modelId - the `publisher/model` the turn ran on; omitted by callers
 *   that settle at the base rate on purpose.
 */
export async function finalizeCredits(
  reservation: CreditReservation,
  usage: CreditUsage,
  modelId?: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCredits(usage, modelId);
    log.credits.info({ totalTokens: usage.totalTokens, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, systemTokens: usage.systemPromptTokens || 0, reasoningTokens: usage.reasoningTokens || 0 }, 'Token usage');
    return await _adjustReservation(reservation, actualCreditsNeeded, 'chat');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing credits');
    throw error;
  }
}

/**
 * Settle a reservation against a credit count the caller ALREADY computed.
 *
 * ## Why this exists, rather than another conversion
 *
 * `finalizeCredits` takes tokens, because that is the unit a chat turn is
 * measured in. A generated show is not: it is priced from the DURATION of the
 * audio it produced, by a formula that belongs to the show module.
 *
 * Before this existed, the show pipeline bridged the gap by inventing a token
 * count — `finalizeCredits(reservation, { totalTokens: credits * 50 })` — which
 * is not a conversion but a coincidence. `calculateCredits` divides by
 * `TOKENS_PER_CREDIT`, which is 1000, so `credits * 50` tokens settles as
 * `ceil(credits / 20)`: a show intending to charge 8 credits charged 1. The
 * factor and the divisor were never related, so nothing about the
 * expression looked wrong, and no test could catch it — both sides typecheck
 * and both are integers.
 *
 * A caller that knows its own price should say the price. That is all this is:
 * the same refund-if-over, charge-if-under adjustment every other finalizer
 * runs, with no unit in the middle to get wrong.
 *
 * ## The token round trip is not merely ugly, it is CONDITIONALLY correct
 *
 * The obvious repair for the laundering above is to keep going through
 * `finalizeCredits` and pass `credits * TOKENS_PER_CREDIT` instead. That does
 * round-trip at the base rate — but only while `modelId` is omitted, so a
 * caller adding one later silently reprices its own work at that model's
 * token prices. The identity holds by accident of an argument nobody
 * passed, which is the same shape as the bug it would be fixing.
 *
 * ## What the CALLER must do with the return value
 *
 * `creditsCharged` is what was SETTLED, after the floor and the rounding below.
 * A caller that records a cost must record THIS, not the number it asked for.
 * The show pipeline stored its intended figure while the ledger moved a
 * different one, and the two disagreed for as long as that code existed because
 * nothing ever compared them.
 *
 * `label` names the domain in the ledger logs, exactly as `'chat'` does.
 */
export async function finalizeFixedCredits(
  reservation: CreditReservation,
  credits: number,
  label: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  /**
   * Floored at the minimum and rounded UP, here rather than in the caller.
   *
   * `calculateCredits` ends on
   * `Math.max(Math.ceil(…), MIN_CREDITS_PER_REQUEST)`, so a caller reaching
   * `_adjustReservation` without it would be the one billing path that can
   * charge a fraction of a credit, or zero. Doing it here keeps the two
   * finalizers agreeing about what a settled charge can be.
   */
  const chargeable = Math.max(Math.ceil(credits), CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
  return _adjustReservation(reservation, chargeable, label);
}

/**
 * Safely refund a credit reservation, swallowing errors.
 * Use this in error-handling paths where you must not throw.
 */
export async function safeRefund(
  reservation: CreditReservation | null,
  reason?: string
): Promise<void> {
  if (!reservation) return;
  await refundReservation(reservation);
  if (reason) {
    log.credits.info({ reason }, 'Refunded credits');
  }
}

/**
 * Which balance a reservation is given back to.
 *
 * ## Returning everything to `free` DESTROYED purchased credit
 *
 * `refreshFreeCreditsIfDue` runs `SET credits_free = credits_free_limit` — an
 * assignment, not an increment — once a day, and `GET /credits` triggers it on
 * every balance view. So a credit taken out of `credits_paid` and handed back to
 * `credits_free` survives only until the next refresh, and then is gone. The
 * customer sees a correct total in between, which is why nothing ever reported
 * it: the money disappears one refresh after the refund, attributable to
 * nothing.
 *
 * `credits_paid` is the durable bucket — purchases and promotional grants
 * (`routes/referrals.ts`) — and the refresh never touches it.
 *
 * ## The bound on `grantKind`, which is not exact and does not need to be
 *
 * `domain/credit-funding.ts` states the imprecision: a reservation that takes
 * the free allowance to exactly zero reads as `paid_balance` though it may have
 * come wholly out of the allowance. Refunding it to `paid` therefore credits up
 * to `creditsReserved` more purchased balance than was taken.
 *
 * That is at most ONE reservation per account per allowance refresh — the single
 * one that crosses the boundary — and only when it is refunded rather than
 * charged. Against it: every reservation of an account whose allowance is
 * already spent was funded from money and was previously confiscated, every
 * time. The residual error is bounded, rare, and falls on the customer's side;
 * the behaviour it replaces was unbounded, common, and fell on ours.
 *
 * Making it exact would mean `spendCreditsFreeFirst` reporting the split it
 * applied, which its post-spend RETURNING cannot express — that is a change to
 * the one-statement shape of the balance path, not to a refund.
 */
function refundBucket(reservation: CreditReservation): 'free' | 'paid' {
  return reservation.grantKind === 'paid_balance' ? 'paid' : 'free';
}

/**
 * Refund all reserved credits (in case of error before streaming)
 */
export async function refundReservation(reservation: CreditReservation): Promise<void> {
  try {
    const bucket = refundBucket(reservation);
    await addCreditsToBalance(getDb(), reservation.userId, reservation.creditsReserved, bucket);
    log.credits.info({ refunded: reservation.creditsReserved, userId: reservation.userId, bucket }, 'Refunded credits to user');
  } catch (error) {
    log.credits.error({ err: error }, 'Error refunding credits');
  }
}

/**
 * Get current credits for a user
 */
export async function getUserCredits(userId: string): Promise<{ free: number; paid: number; total: number } | null> {
  try {
    const userCredits = await findUserCredits(getDb(), userId);
    if (!userCredits) {
      return null;
    }

    return {
      free: userCredits.creditsFree,
      paid: userCredits.creditsPaid,
      total: userCredits.creditsFree + userCredits.creditsPaid,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting user credits');
    return null;
  }
}
