/**
 * Voice usage tracking helper.
 * Queries VoiceCallUsage to determine how many voice minutes
 * a user has consumed in the current billing period.
 */

import { getDb } from '../db/index.js';
import { sumVoiceMinutesUsed } from '../db/usage/voiceCallUsageRepository.js';
import { findActiveSubscriptionByPeriodStart } from '../db/billing/subscriptionRepository.js';

export interface VoiceUsageSummary {
  usedMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
}

/**
 * Get the current billing period start for the user.
 * Falls back to start of current calendar month if no active subscription.
 */
async function getCurrentPeriodStart(userId: string): Promise<Date> {
  const sub = await findActiveSubscriptionByPeriodStart(getDb(), userId);

  if (sub?.currentPeriodStart) {
    return sub.currentPeriodStart;
  }

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Get total voice minutes used since a given date.
 * Sums durationMinutes + cohostDurationMinutes from completed sessions.
 */
async function getVoiceMinutesUsed(userId: string, since: Date): Promise<number> {
  return sumVoiceMinutesUsed(getDb(), userId, since);
}

/**
 * Get voice usage summary for a user given their voice-minutes entitlement.
 */
export async function getVoiceUsageSummary(
  userId: string,
  limitMinutes: number,
): Promise<VoiceUsageSummary> {
  const periodStart = await getCurrentPeriodStart(userId);
  const usedMinutes = await getVoiceMinutesUsed(userId, periodStart);

  return {
    usedMinutes: Math.round(usedMinutes * 100) / 100,
    limitMinutes,
    remainingMinutes: Math.max(0, limitMinutes - usedMinutes),
  };
}
