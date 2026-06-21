/**
 * Voice usage tracking helper.
 * Queries VoiceCallUsage to determine how many voice minutes
 * a user has consumed in the current billing period.
 */

import { VoiceCallUsage } from '../models/voice-call-usage.js';
import { Subscription } from '../models/subscription.js';

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
  const sub = await Subscription.findOne({
    oxyUserId: userId,
    status: { $in: ['active', 'trialing'] },
  })
    .sort({ currentPeriodStart: -1 })
    .lean();

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
  const result = await VoiceCallUsage.aggregate([
    {
      $match: {
        oxyUserId: userId,
        startTime: { $gte: since },
        endTime: { $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        totalMinutes: {
          $sum: { $add: ['$durationMinutes', '$cohostDurationMinutes'] },
        },
      },
    },
  ]);

  return result[0]?.totalMinutes || 0;
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
