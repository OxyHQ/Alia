import { getDb } from '../db/index.js';
import {
  addCredits as addCreditsToBalance,
  findUserCredits,
  spendCreditsFreeFirst,
  zeroCredits,
  type UserCreditsRow,
} from '../db/billing/userCreditsRepository.js';
import { log } from './logger.js';
import { getRoutingPreset } from './routing/presets.js';
import { fundingSourceOf, type CreditFundingSource } from '../domain/credit-funding.js';

/**
 * Credits Manager
 * Centralized utility for managing AI credits based on token usage
 * Supports tier-based credit multipliers for different Kaana routing profiles
 */

export interface CreditUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  systemPromptTokens?: number; // Tokens from our system prompt (not charged to user)
  /**
   * The output tokens the model spent THINKING, as the provider reported them.
   *
   * Already inside {@link totalTokens} — this is not extra volume, it is a
   * breakdown of volume already counted, and it exists so those tokens can be
   * weighted rather than counted twice. `ai@6` reports it as
   * `usage.outputTokenDetails.reasoningTokens`; a provider that does not report
   * it leaves this `0`, which bills the turn exactly as it billed before.
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
  // How many tokens per 1 credit
  TOKENS_PER_CREDIT: 1000,

  // Minimum credits to charge per request
  MIN_CREDITS_PER_REQUEST: 1,

  // Initial credits to reserve (will be adjusted based on actual usage)
  INITIAL_RESERVATION: 1,

  /**
   * What one reasoning token costs, relative to every other token.
   *
   * ## The formula bills all tokens alike; providers do not
   *
   * `calculateCreditsFromTokens` charges `totalTokens / TOKENS_PER_CREDIT`
   * times the model's multiplier, which prices an input token and an output
   * token identically. Providers price them 4 to 8 times apart, and a reasoning
   * token is unambiguously an OUTPUT token — so reasoning is the one thing a
   * person can switch on that makes a turn cost multiples more per token than
   * the formula charges for it.
   *
   * ## 5 is the median of the measured ratio, not a guess
   *
   * Output ÷ input price for every model in `model-capabilities-data.ts` that
   * this product can send a reasoning option to, or would be able to:
   * claude-sonnet-4 15/3 = 5.0 · claude-opus-4 75/15 = 5.0 · claude-opus-4-5
   * 25/5 = 5.0 · gemini-2.5-pro 10/1.25 = 8.0 · gemini-2.5-flash 2.5/0.30 =
   * 8.3 · gemini-3-pro-preview 12/2 = 6.0 · gemini-3-flash-preview 3/0.50 =
   * 6.0 · o1 60/15 = 4.0 · o3 8/2 = 4.0 · gpt-5 10/1.25 = 8.0 · deepseek-reasoner
   * 2.19/0.55 = 4.0. Range 4.0–8.3, median 5.0.
   *
   * The median rather than the maximum: 8.3 would overcharge everyone who
   * reasons on Anthropic, which is where the dearest reasoning actually
   * happens, and this number decides a person's bill.
   *
   * ## It is charged on tokens SPENT, never on the budget offered
   *
   * The budget is a ceiling the provider may not reach. Weighting the reported
   * count means a turn that thought for 300 tokens is charged for 300, and the
   * ceiling only bounds the worst case: at `max`, 6144 reasoning tokens weight
   * to 30,720 — about 31 credits before the model multiplier, against roughly 2
   * for an ordinary turn. In money on the models this reaches, 6144 output
   * tokens is $0.09 on Sonnet at $15/1M and $0.46 on Opus at $75/1M.
   *
   * A request that asks for no reasoning is untouched: `reasoningTokens` is 0,
   * the weighted term vanishes, and the arithmetic is the one that ran before.
   */
  REASONING_TOKEN_WEIGHT: 5,
};

/**
 * A charge that named a model nothing can price.
 *
 * A distinct type rather than a bare `Error` so callers and observability can
 * distinguish an invalid routing profile from an accounting failure. It is
 * raised before any balance moves — see {@link getCreditMultiplier} — and must
 * remain separate from failures that can happen after a reservation.
 */
export class UnpricedModelError extends Error {
  constructor(readonly routingProfileId: string) {
    super(`No credit multiplier is registered for model "${routingProfileId}"`);
    this.name = 'UnpricedModelError';
  }
}

/**
 * What a turn on this model costs, relative to the base rate.
 *
 * ## An ABSENT identifier and an UNKNOWN one are different facts
 *
 * `undefined` means the caller priced the turn itself and is saying so.
 * `routes/v1/images.ts`, both handlers in `routes/v1/audio.ts`, the transcribe
 * path in `routes/v1/voice.ts`, `lib/chat-modes/deep-research-handler.ts` and
 * `lib/agent/runner.ts` each compute their own token count from their own
 * formula and settle it at the base rate deliberately. For them 1 is the
 * answer, not a fallback, which is why this case is kept and not folded in
 * below.
 *
 * A STRING that resolves to nothing is the opposite: somebody named a model and
 * nothing can price it. That returned 1 as well — `model?.creditMultiplier || 1`
 * — so the two were indistinguishable and the second was silent. The registered
 * multipliers span 0.5 to 5, so an identifier that stopped resolving repriced
 * every request on it, in either direction, with nothing logged and no test
 * red: `kaana-lite` at 1 is double what the customer agreed to, and
 * `kaana-v1-pro-max` at 1 is a fifth of it. `credit-multipliers.test.ts` names
 * this exact hole, and until now could only pin the values it would have
 * hidden.
 *
 * `|| 1` also swallowed a registered multiplier of 0. The column is constrained
 * `between 0.1 and 10` (`db/schema/providers.ts`), so that is not reachable
 * today, but the read no longer depends on it being unreachable.
 *
 * ## The price comes from the ROUTING PRESET, not from the alias record
 *
 * `lib/routing/presets.ts` owns it. The two tables carry the same numbers and
 * `routing-policy.test.ts` fails if they stop, so this is not a repricing — it
 * is what lets the thirteen `alia-*` identifiers be deleted without taking
 * every price with them. It also takes billing off the model catalogue: this
 * read no longer goes through `gateway-client`, so no charge depends on a
 * catalogue fetch.
 *
 * ## It throws BEFORE any balance moves, and callers rely on that
 *
 * Every route into this function goes through `calculateCreditsFromTokens` or
 * `calculateCreditsFromMinutes`, both of which resolve the multiplier before
 * `_adjustReservation` touches a row. So a throw leaves the reservation exactly
 * as it was found — never half-settled — and each caller's existing release
 * point gives it back: the chat path leaves `creditsSettled` false and
 * `routes/v1/chat-completions.ts` refunds, while both webhook handlers refund
 * in their `finally` blocks.
 */
export async function getCreditMultiplier(routingProfileId?: string): Promise<number> {
  if (routingProfileId === undefined) return 1;
  const preset = getRoutingPreset(routingProfileId);
  if (preset === null) throw new UnpricedModelError(routingProfileId);
  return preset.creditMultiplier;
}

/**
 * Calculate credits needed based on token usage and model tier
 * Formula: Math.ceil((billableTokens / TOKENS_PER_CREDIT) * creditMultiplier)
 * Minimum: MIN_CREDITS_PER_REQUEST
 *
 * @param totalTokens - Total tokens reported by the provider
 * @param routingProfileId - The Kaana routing profile being used
 * @param systemPromptTokens - Tokens from our system prompt (not charged to user)
 */
export async function calculateCreditsFromTokens(
  totalTokens: number,
  routingProfileId?: string,
  systemPromptTokens?: number,
  reasoningTokens?: number
): Promise<number> {
  if (totalTokens === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  // Subtract system prompt tokens (our cost, not the user's)
  const systemTokens = systemPromptTokens || 0;
  const countedTokens = Math.max(0, totalTokens - systemTokens);

  /**
   * Reasoning tokens, re-weighted rather than re-counted.
   *
   * They are ALREADY inside `totalTokens`, so they are removed at weight 1 and
   * added back at {@link CREDITS_CONFIG.REASONING_TOKEN_WEIGHT} — the surcharge
   * is `(weight - 1)` per token, not `weight`. Adding the weighted figure to an
   * unreduced total would charge the first copy of every reasoning token twice.
   *
   * Clamped to what is left after the system prompt: a provider reporting more
   * reasoning tokens than remain would otherwise drive the billable count
   * negative through the subtraction.
   */
  const reasoned = Math.min(Math.max(0, reasoningTokens || 0), countedTokens);
  const billableTokens = countedTokens - reasoned + reasoned * CREDITS_CONFIG.REASONING_TOKEN_WEIGHT;

  log.credits.info({ totalTokens, systemTokens, reasoningTokens: reasoned, billableTokens }, 'Token breakdown');

  const multiplier = await getCreditMultiplier(routingProfileId);
  const calculatedCredits = Math.ceil((billableTokens / CREDITS_CONFIG.TOKENS_PER_CREDIT) * multiplier);
  return Math.max(calculatedCredits, CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
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
 * Shared credit adjustment logic used by both finalizeCredits and finalizeVoiceCredits.
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
    // To the bucket that funded the reservation — see `refundBucket`. A voice
    // call reserves 50 credits a minute and settles a fraction of that, so this
    // is the path that moved the most purchased credit into `free`.
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
 * Adjust credits based on actual token usage and model tier
 * If actual usage > reserved: deduct more
 * If actual usage < reserved: refund difference
 */
export async function finalizeCredits(
  reservation: CreditReservation,
  usage: CreditUsage,
  routingProfileId?: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromTokens(
      usage.totalTokens,
      routingProfileId,
      usage.systemPromptTokens,
      usage.reasoningTokens
    );
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
 * `finalizeCredits` takes tokens and `finalizeVoiceCredits` takes minutes,
 * because those are the units a chat turn and a voice call are measured in. A
 * generated show is measured in neither: it is priced from the DURATION of the
 * audio it produced, by a formula that belongs to the show module.
 *
 * Before this existed, the show pipeline bridged the gap by inventing a token
 * count — `finalizeCredits(reservation, { totalTokens: credits * 50 })` — which
 * is not a conversion but a coincidence. `calculateCreditsFromTokens` divides by
 * `TOKENS_PER_CREDIT`, which is 1000, so `credits * 50` tokens settles as
 * `ceil(credits / 20)`: a show intending to charge 8 credits charged 1. The
 * multiplier and the divisor were never related, so nothing about the
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
 * round-trip — `calculateCreditsFromTokens` returns
 * `ceil(credits * multiplier)` — but only while `routingProfileId` is omitted, so a
 * caller adding one later silently multiplies its own price by that model's
 * credit multiplier. The identity holds by accident of an argument nobody
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
 * `label` names the domain in the ledger logs, exactly as `'chat'` and
 * `'voice'` do.
 */
export async function finalizeFixedCredits(
  reservation: CreditReservation,
  credits: number,
  label: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  /**
   * Floored at the minimum and rounded UP, here rather than in the caller.
   *
   * `calculateCreditsFromTokens` and `calculateCreditsFromMinutes` both end on
   * `Math.max(Math.ceil(…), MIN_CREDITS_PER_REQUEST)`, so a caller reaching
   * `_adjustReservation` without it would be the one billing path that can
   * charge a fraction of a credit, or zero. Doing it here keeps the three
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

// ============== VOICE (TIME-BASED) BILLING ==============

/**
 * Calculate credits needed based on minutes and cost per minute
 * Used for voice/realtime API calls that are billed per minute
 *
 * @param minutes - Total minutes of voice call
 * @param routingProfileId - The Kaana routing profile being used
 * @param costPerMinute - Provider's cost per minute (e.g., 0.05 for Grok)
 * @returns Credits to charge
 */
export async function calculateCreditsFromMinutes(
  minutes: number,
  routingProfileId: string,
  costPerMinute: number
): Promise<number> {
  if (minutes === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  const multiplier = await getCreditMultiplier(routingProfileId);

  // Convert to credits: $1 = 1000 credits
  // Example: $0.05/min * 1000 = 50 credits/min
  const baseCredits = Math.ceil(minutes * costPerMinute * 1000);
  const calculatedCredits = Math.ceil(baseCredits * multiplier);

  log.credits.info({ minutes: minutes.toFixed(2), costPerMinute, multiplier, calculatedCredits }, 'Voice credits calculated');

  return Math.max(calculatedCredits, CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
}

/**
 * Reserve credits for a voice call (time-based)
 * Reserves credits for an estimated duration
 *
 * @param userId - User ID
 * @param estimatedMinutes - Estimated call duration in minutes
 * @param routingProfileId - The Kaana routing profile being used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credit reservation or null if insufficient
 */
export async function reserveVoiceCredits(
  userId: string,
  estimatedMinutes: number = 1,
  routingProfileId: string = 'kaana-v1-voice',
  costPerMinute: number = 0.05
): Promise<CreditReservation | null> {
  const estimatedCredits = await calculateCreditsFromMinutes(
    estimatedMinutes,
    routingProfileId,
    costPerMinute
  );

  log.credits.info({ estimatedCredits, estimatedMinutes }, 'Reserving credits for voice call');

  return reserveCredits(userId, estimatedCredits);
}

/**
 * Finalize voice call credits based on actual duration
 * Adjusts the reservation based on actual time used
 *
 * @param reservation - The initial credit reservation
 * @param actualMinutes - Actual call duration in minutes
 * @param routingProfileId - The Kaana routing profile used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credits charged and remaining
 */
export async function finalizeVoiceCredits(
  reservation: CreditReservation,
  actualMinutes: number,
  routingProfileId: string,
  costPerMinute: number
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromMinutes(
      actualMinutes,
      routingProfileId,
      costPerMinute
    );
    log.credits.info({ duration: actualMinutes.toFixed(2), costPerMinute }, 'Voice call duration');
    return await _adjustReservation(reservation, actualCreditsNeeded, 'voice');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing voice credits');
    throw error;
  }
}
