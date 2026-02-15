import { UserCredits } from '../models/user-credits.js';
import { getAliaModel } from './chat-core.js';
import { log } from './logger.js';

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
}

export interface CreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
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
};

/**
 * Get credit multiplier for an Alia model
 */
export function getCreditMultiplier(aliasModelId?: string): number {
  if (!aliasModelId) return 1;
  const model = getAliaModel(aliasModelId);
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
export function calculateCreditsFromTokens(
  totalTokens: number,
  aliasModelId?: string,
  systemPromptTokens?: number
): number {
  if (totalTokens === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  // Subtract system prompt tokens (our cost, not the user's)
  const systemTokens = systemPromptTokens || 0;
  const billableTokens = Math.max(0, totalTokens - systemTokens);

  log.credits.info({ totalTokens, systemTokens, billableTokens }, 'Token breakdown');

  const multiplier = getCreditMultiplier(aliasModelId);
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
    // Try to deduct from free credits first, then paid
    const reserveResult = await UserCredits.findOneAndUpdate(
      {
        _id: userId,
        $expr: {
          $gte: [{ $add: ['$credits.free', '$credits.paid'] }, amount]
        }
      },
      [
        {
          $set: {
            'credits.free': {
              $cond: {
                if: { $gte: ['$credits.free', amount] },
                then: { $subtract: ['$credits.free', amount] },
                else: 0
              }
            },
            'credits.paid': {
              $cond: {
                if: { $gte: ['$credits.free', amount] },
                then: '$credits.paid',
                else: { $subtract: ['$credits.paid', { $subtract: [amount, '$credits.free'] }] }
              }
            },
            'credits.lastUsed': new Date()
          }
        }
      ],
      { new: true, runValidators: false, updatePipeline: true }
    );

    if (!reserveResult) {
      log.credits.info({ userId }, 'Insufficient credits for user');
      return null;
    }

    log.credits.info({ amount, userId }, 'Reserved credits for user');
    log.credits.info({ free: reserveResult.credits.free, paid: reserveResult.credits.paid }, 'Remaining credits');

    return {
      userId,
      creditsReserved: amount,
      initialFreeCredits: reserveResult.credits.free,
      initialPaidCredits: reserveResult.credits.paid,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error reserving credits');
    throw error;
  }
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
    const actualCreditsNeeded = calculateCreditsFromTokens(
      usage.totalTokens,
      aliasModelId,
      usage.systemPromptTokens
    );
    const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;

    log.credits.info({ userId: reservation.userId, reserved: reservation.creditsReserved, actualNeeded: actualCreditsNeeded }, 'Finalizing credits');
    log.credits.info({ totalTokens: usage.totalTokens, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, systemTokens: usage.systemPromptTokens || 0 }, 'Tokens used');
    log.credits.info({ creditAdjustment }, 'Credit adjustment');

    let updatedCredits = await UserCredits.findById(reservation.userId);

    if (!updatedCredits) {
      throw new Error('User credits not found');
    }

    // If we need to adjust (either refund or charge more)
    if (creditAdjustment !== 0) {
      if (creditAdjustment > 0) {
        // Refund: we reserved more than needed
        updatedCredits = await UserCredits.findByIdAndUpdate(
          reservation.userId,
          { $inc: { 'credits.free': creditAdjustment } },
          { new: true, runValidators: false }
        );
        log.credits.info({ refunded: creditAdjustment }, 'Refunded credits');
      } else {
        // Charge more: actual usage exceeded reservation
        const additionalCredits = Math.abs(creditAdjustment);

        // Try to deduct additional credits
        updatedCredits = await UserCredits.findOneAndUpdate(
          {
            _id: reservation.userId,
            $expr: {
              $gte: [{ $add: ['$credits.free', '$credits.paid'] }, additionalCredits]
            }
          },
          [
            {
              $set: {
                'credits.free': {
                  $cond: {
                    if: { $gte: ['$credits.free', additionalCredits] },
                    then: { $subtract: ['$credits.free', additionalCredits] },
                    else: 0
                  }
                },
                'credits.paid': {
                  $cond: {
                    if: { $gte: ['$credits.free', additionalCredits] },
                    then: '$credits.paid',
                    else: { $subtract: ['$credits.paid', { $subtract: [additionalCredits, '$credits.free'] }] }
                  }
                }
              }
            }
          ],
          { new: true, runValidators: false, updatePipeline: true }
        );

        if (!updatedCredits) {
          // Insufficient credits for additional charge - set to 0
          updatedCredits = await UserCredits.findByIdAndUpdate(
            reservation.userId,
            { $set: { 'credits.free': 0, 'credits.paid': 0 } },
            { new: true }
          );
          log.credits.warn('Insufficient credits for additional charge, set to 0');
        } else {
          log.credits.info({ additionalCredits }, 'Charged additional credits');
        }
      }
    }

    if (!updatedCredits) {
      throw new Error('Failed to update credits');
    }

    const totalRemaining = updatedCredits.credits.free + updatedCredits.credits.paid;
    log.credits.info({ free: updatedCredits.credits.free, paid: updatedCredits.credits.paid, total: totalRemaining }, 'Final credits');

    return {
      creditsCharged: actualCreditsNeeded,
      creditsRemaining: totalRemaining,
    };
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
    await UserCredits.findByIdAndUpdate(
      reservation.userId,
      { $inc: { 'credits.free': reservation.creditsReserved } },
      { runValidators: false }
    );
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
    const userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      return null;
    }

    return {
      free: userCredits.credits.free,
      paid: userCredits.credits.paid,
      total: userCredits.credits.free + userCredits.credits.paid,
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
export function calculateCreditsFromMinutes(
  minutes: number,
  aliasModelId: string,
  costPerMinute: number
): number {
  if (minutes === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  const multiplier = getCreditMultiplier(aliasModelId);

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
  const estimatedCredits = calculateCreditsFromMinutes(
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
    const actualCreditsNeeded = calculateCreditsFromMinutes(
      actualMinutes,
      aliasModelId,
      costPerMinute
    );
    const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;

    log.credits.info({ userId: reservation.userId, reserved: reservation.creditsReserved, actualNeeded: actualCreditsNeeded }, 'Finalizing voice credits');
    log.credits.info({ duration: actualMinutes.toFixed(2), costPerMinute }, 'Voice call duration');
    log.credits.info({ creditAdjustment }, 'Voice credit adjustment');

    let updatedCredits = await UserCredits.findById(reservation.userId);

    if (!updatedCredits) {
      throw new Error('User credits not found');
    }

    // If we need to adjust (either refund or charge more)
    if (creditAdjustment !== 0) {
      if (creditAdjustment > 0) {
        // Refund: we reserved more than needed
        updatedCredits = await UserCredits.findByIdAndUpdate(
          reservation.userId,
          { $inc: { 'credits.free': creditAdjustment } },
          { new: true, runValidators: false }
        );
        log.credits.info({ refunded: creditAdjustment }, 'Refunded credits');
      } else {
        // Charge more: actual usage exceeded reservation
        const additionalCredits = Math.abs(creditAdjustment);

        // Try to deduct additional credits
        updatedCredits = await UserCredits.findOneAndUpdate(
          {
            _id: reservation.userId,
            $expr: {
              $gte: [{ $add: ['$credits.free', '$credits.paid'] }, additionalCredits]
            }
          },
          [
            {
              $set: {
                'credits.free': {
                  $cond: {
                    if: { $gte: ['$credits.free', additionalCredits] },
                    then: { $subtract: ['$credits.free', additionalCredits] },
                    else: 0
                  }
                },
                'credits.paid': {
                  $cond: {
                    if: { $gte: ['$credits.free', additionalCredits] },
                    then: '$credits.paid',
                    else: { $subtract: ['$credits.paid', { $subtract: [additionalCredits, '$credits.free'] }] }
                  }
                }
              }
            }
          ],
          { new: true, runValidators: false, updatePipeline: true }
        );

        if (!updatedCredits) {
          // Insufficient credits for additional charge - set to 0
          updatedCredits = await UserCredits.findByIdAndUpdate(
            reservation.userId,
            { $set: { 'credits.free': 0, 'credits.paid': 0 } },
            { new: true }
          );
          log.credits.warn('Insufficient credits for additional charge, set to 0');
        } else {
          log.credits.info({ additionalCredits }, 'Charged additional credits');
        }
      }
    }

    if (!updatedCredits) {
      throw new Error('Failed to update credits');
    }

    const totalRemaining = updatedCredits.credits.free + updatedCredits.credits.paid;
    log.credits.info({ free: updatedCredits.credits.free, paid: updatedCredits.credits.paid, total: totalRemaining }, 'Final voice credits');

    return {
      creditsCharged: actualCreditsNeeded,
      creditsRemaining: totalRemaining,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing voice credits');
    throw error;
  }
}
