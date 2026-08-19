import { getDb } from '../db/index.js';
import {
  addCredits as addCreditsToBalance,
  findUserCredits,
  spendCreditsFreeFirst,
  zeroCredits,
  type UserCreditsRow,
} from '../db/billing/userCreditsRepository.js';
import { getAliaModel } from './chat-core.js';
import { log } from './logger.js';
import type { CreditFundingSource } from '../domain/credit-funding.js';

/**
 * Credits Manager
 * Centralized utility for managing AI credits based on token usage
 * Supports tier-based credit multipliers for different Alia models
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
 * Get credit multiplier for an Alia model
 */
export async function getCreditMultiplier(aliasModelId?: string): Promise<number> {
  if (!aliasModelId) return 1;
  const model = await getAliaModel(aliasModelId);
  return model?.creditMultiplier || 1;
}

/**
 * Calculate credits needed based on token usage and model tier
 * Formula: Math.ceil((billableTokens / TOKENS_PER_CREDIT) * creditMultiplier)
 * Minimum: MIN_CREDITS_PER_REQUEST
 *
 * @param totalTokens - Total tokens reported by the provider
 * @param aliasModelId - The Alia model being used
 * @param systemPromptTokens - Tokens from our system prompt (not charged to user)
 */
export async function calculateCreditsFromTokens(
  totalTokens: number,
  aliasModelId?: string,
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

  const multiplier = await getCreditMultiplier(aliasModelId);
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
    const grantKind: CreditFundingSource =
      reserveResult.creditsFree > 0 ? 'free_allowance' : 'paid_balance';

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
    updatedCredits = await addCreditsToBalance(getDb(), reservation.userId, creditAdjustment, 'free');
    if (updatedCredits) {
      log.credits.info({ refunded: creditAdjustment }, `Refunded ${label} credits`);
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
  aliasModelId?: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromTokens(
      usage.totalTokens,
      aliasModelId,
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
 * Refund all reserved credits (in case of error before streaming)
 */
export async function refundReservation(reservation: CreditReservation): Promise<void> {
  try {
    await addCreditsToBalance(getDb(), reservation.userId, reservation.creditsReserved, 'free');
    log.credits.info({ refunded: reservation.creditsReserved, userId: reservation.userId }, 'Refunded credits to user');
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
 * @param aliasModelId - The Alia model being used
 * @param costPerMinute - Provider's cost per minute (e.g., 0.05 for Grok)
 * @returns Credits to charge
 */
export async function calculateCreditsFromMinutes(
  minutes: number,
  aliasModelId: string,
  costPerMinute: number
): Promise<number> {
  if (minutes === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  const multiplier = await getCreditMultiplier(aliasModelId);

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
 * @param aliasModelId - The Alia model being used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credit reservation or null if insufficient
 */
export async function reserveVoiceCredits(
  userId: string,
  estimatedMinutes: number = 1,
  aliasModelId: string = 'alia-v1-voice',
  costPerMinute: number = 0.05
): Promise<CreditReservation | null> {
  const estimatedCredits = await calculateCreditsFromMinutes(
    estimatedMinutes,
    aliasModelId,
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
 * @param aliasModelId - The Alia model used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credits charged and remaining
 */
export async function finalizeVoiceCredits(
  reservation: CreditReservation,
  actualMinutes: number,
  aliasModelId: string,
  costPerMinute: number
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromMinutes(
      actualMinutes,
      aliasModelId,
      costPerMinute
    );
    log.credits.info({ duration: actualMinutes.toFixed(2), costPerMinute }, 'Voice call duration');
    return await _adjustReservation(reservation, actualCreditsNeeded, 'voice');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing voice credits');
    throw error;
  }
}
