import { UserCredits } from '../models/user-credits.js';
import { getAliaModel } from './alia-models.js';

/**
 * Credits Manager
 * Centralized utility for managing AI credits based on token usage
 * Supports tier-based credit multipliers for different Alia models
 */

export interface CreditUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
 * Formula: Math.ceil((totalTokens / TOKENS_PER_CREDIT) * creditMultiplier)
 * Minimum: MIN_CREDITS_PER_REQUEST
 */
export function calculateCreditsFromTokens(totalTokens: number, aliasModelId?: string): number {
  if (totalTokens === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  const multiplier = getCreditMultiplier(aliasModelId);
  const calculatedCredits = Math.ceil((totalTokens / CREDITS_CONFIG.TOKENS_PER_CREDIT) * multiplier);
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
      console.log('[CreditsManager] Insufficient credits for user:', userId);
      return null;
    }

    console.log(`[CreditsManager] Reserved ${amount} credits for user ${userId}`);
    console.log(`[CreditsManager] Remaining: ${reserveResult.credits.free} free, ${reserveResult.credits.paid} paid`);

    return {
      userId,
      creditsReserved: amount,
      initialFreeCredits: reserveResult.credits.free,
      initialPaidCredits: reserveResult.credits.paid,
    };
  } catch (error) {
    console.error('[CreditsManager] Error reserving credits:', error);
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
    const actualCreditsNeeded = calculateCreditsFromTokens(usage.totalTokens, aliasModelId);
    const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;

    console.log(`[CreditsManager] Finalizing credits for user ${reservation.userId}`);
    console.log(`[CreditsManager] Reserved: ${reservation.creditsReserved}, Actual needed: ${actualCreditsNeeded}`);
    console.log(`[CreditsManager] Tokens used: ${usage.totalTokens} (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})`);
    console.log(`[CreditsManager] Adjustment: ${creditAdjustment}`);

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
        console.log(`[CreditsManager] Refunded ${creditAdjustment} credits`);
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
          console.log(`[CreditsManager] WARNING: Insufficient credits for additional charge. Set to 0.`);
        } else {
          console.log(`[CreditsManager] Charged additional ${additionalCredits} credits`);
        }
      }
    }

    if (!updatedCredits) {
      throw new Error('Failed to update credits');
    }

    const totalRemaining = updatedCredits.credits.free + updatedCredits.credits.paid;
    console.log(`[CreditsManager] Final credits: ${updatedCredits.credits.free} free, ${updatedCredits.credits.paid} paid (total: ${totalRemaining})`);

    return {
      creditsCharged: actualCreditsNeeded,
      creditsRemaining: totalRemaining,
    };
  } catch (error) {
    console.error('[CreditsManager] Error finalizing credits:', error);
    throw error;
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
    console.log(`[CreditsManager] Refunded ${reservation.creditsReserved} credits to user ${reservation.userId}`);
  } catch (error) {
    console.error('[CreditsManager] Error refunding credits:', error);
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
    console.error('[CreditsManager] Error getting user credits:', error);
    return null;
  }
}
