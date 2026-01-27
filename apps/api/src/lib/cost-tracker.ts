/**
 * Cost Tracking & Optimization
 *
 * Tracks real-time costs per request, aggregates by user/model,
 * and provides analytics for cost optimization.
 */

import { connectDB } from './db.js';
import mongoose from 'mongoose';
import { getModelPricing } from './model-capabilities-data.js';

// ============== TYPES ==============

export interface CostEntry {
  userId: string;
  sessionId?: string;
  aliasModelId: string;      // User sees this (e.g., "alia-v1-pro")
  actualProvider: string;    // Internal only
  actualModelId: string;     // Internal only
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  savedFromCache: boolean;
  timestamp: Date;
}

export interface UserCostSummary {
  userId: string;
  totalSpent: number;
  totalTokens: number;
  totalRequests: number;
  costByModel: Record<string, number>;  // Only Alia model names!
  tokensByModel: Record<string, number>;
  avgCostPerRequest: number;
  estimatedMonthlyCost: number;
  cacheSavings: number;
  freeTierSavings: number;  // Savings from using free providers
}

// ============== MONGODB SCHEMA ==============

const CostEntrySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  sessionId: { type: String, index: true },
  aliasModelId: { type: String, required: true, index: true },
  actualProvider: { type: String, required: true },
  actualModelId: { type: String, required: true },
  inputTokens: { type: Number, required: true },
  outputTokens: { type: Number, required: true },
  totalTokens: { type: Number, required: true },
  costUSD: { type: Number, required: true },
  savedFromCache: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
CostEntrySchema.index({ userId: 1, timestamp: -1 });
CostEntrySchema.index({ aliasModelId: 1, timestamp: -1 });
CostEntrySchema.index({ userId: 1, aliasModelId: 1 });

const CostEntryModel = mongoose.model('CostEntry', CostEntrySchema);

// ============== COST CALCULATION ==============

/**
 * Calculate cost for a request based on token usage
 */
export function calculateCost(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(modelId);

  // Free tier models have no cost
  if (pricing.tier === 'free') {
    return 0;
  }

  // Calculate cost per million tokens
  const inputCost = (pricing.costPer1MInput || 0) * (inputTokens / 1_000_000);
  const outputCost = (pricing.costPer1MOutput || 0) * (outputTokens / 1_000_000);

  return inputCost + outputCost;
}

/**
 * Estimate cost savings from using free tier instead of paid
 */
export function estimateFreeTierSavings(
  inputTokens: number,
  outputTokens: number
): number {
  // Compare against a typical paid model (gpt-4o equivalent)
  const paidInputCost = 2.50 * (inputTokens / 1_000_000);
  const paidOutputCost = 10.00 * (outputTokens / 1_000_000);
  return paidInputCost + paidOutputCost;
}

// ============== TRACKING ==============

/**
 * Record a request's cost
 */
export async function recordCost(
  userId: string,
  aliasModelId: string,
  actualProvider: string,
  actualModelId: string,
  inputTokens: number,
  outputTokens: number,
  savedFromCache: boolean = false,
  sessionId?: string
): Promise<void> {
  try {
    const totalTokens = inputTokens + outputTokens;
    const costUSD = calculateCost(actualProvider, actualModelId, inputTokens, outputTokens);

    await connectDB();
    await CostEntryModel.create({
      userId,
      sessionId,
      aliasModelId,
      actualProvider,
      actualModelId,
      inputTokens,
      outputTokens,
      totalTokens,
      costUSD,
      savedFromCache,
      timestamp: new Date()
    });

    console.log(`[CostTracker] 💰 Recorded $${costUSD.toFixed(6)} for ${aliasModelId} (${totalTokens} tokens)${savedFromCache ? ' [CACHED]' : ''}`);
  } catch (error) {
    console.error('[CostTracker] Error recording cost:', error);
  }
}

// ============== ANALYTICS ==============

/**
 * Get cost summary for a user
 */
export async function getUserCostSummary(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<UserCostSummary> {
  try {
    await connectDB();

    const query: any = { userId };
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = startDate;
      if (endDate) query.timestamp.$lte = endDate;
    }

    const entries = await CostEntryModel.find(query);

    let totalSpent = 0;
    let totalTokens = 0;
    let cacheSavings = 0;
    let freeTierSavings = 0;
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<string, number> = {};

    for (const entry of entries) {
      totalSpent += entry.costUSD;
      totalTokens += entry.totalTokens;

      // Aggregate by Alia model (not provider!)
      const model = entry.aliasModelId;
      costByModel[model] = (costByModel[model] || 0) + entry.costUSD;
      tokensByModel[model] = (tokensByModel[model] || 0) + entry.totalTokens;

      // Track cache savings (cost that would have been incurred)
      if (entry.savedFromCache) {
        const wouldHaveCost = calculateCost(
          entry.actualProvider,
          entry.actualModelId,
          entry.inputTokens,
          entry.outputTokens
        );
        cacheSavings += wouldHaveCost;
      }

      // Track free tier savings
      if (entry.costUSD === 0) {
        freeTierSavings += estimateFreeTierSavings(entry.inputTokens, entry.outputTokens);
      }
    }

    const totalRequests = entries.length;
    const avgCostPerRequest = totalRequests > 0 ? totalSpent / totalRequests : 0;

    // Estimate monthly cost based on usage pattern
    const daysOfData = endDate && startDate
      ? Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
      : 30;
    const estimatedMonthlyCost = (totalSpent / daysOfData) * 30;

    return {
      userId,
      totalSpent,
      totalTokens,
      totalRequests,
      costByModel,
      tokensByModel,
      avgCostPerRequest,
      estimatedMonthlyCost,
      cacheSavings,
      freeTierSavings
    };
  } catch (error) {
    console.error('[CostTracker] Error getting user cost summary:', error);
    return {
      userId,
      totalSpent: 0,
      totalTokens: 0,
      totalRequests: 0,
      costByModel: {},
      tokensByModel: {},
      avgCostPerRequest: 0,
      estimatedMonthlyCost: 0,
      cacheSavings: 0,
      freeTierSavings: 0
    };
  }
}

/**
 * Get global cost statistics (admin)
 */
export async function getGlobalCostStats(
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalRevenue: number;
  totalTokens: number;
  totalRequests: number;
  uniqueUsers: number;
  costByAliasModel: Record<string, number>;
  costByActualProvider: Record<string, number>;  // Internal only!
  avgCostPerRequest: number;
  cacheSavingsTotal: number;
  freeTierSavingsTotal: number;
}> {
  try {
    await connectDB();

    const query: any = {};
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = startDate;
      if (endDate) query.timestamp.$lte = endDate;
    }

    const entries = await CostEntryModel.find(query);
    const uniqueUsers = new Set(entries.map(e => e.userId)).size;

    let totalRevenue = 0;
    let totalTokens = 0;
    let cacheSavingsTotal = 0;
    let freeTierSavingsTotal = 0;
    const costByAliasModel: Record<string, number> = {};
    const costByActualProvider: Record<string, number> = {};

    for (const entry of entries) {
      totalRevenue += entry.costUSD;
      totalTokens += entry.totalTokens;

      // By Alia model (user-facing)
      costByAliasModel[entry.aliasModelId] = (costByAliasModel[entry.aliasModelId] || 0) + entry.costUSD;

      // By actual provider (internal analytics only!)
      costByActualProvider[entry.actualProvider] = (costByActualProvider[entry.actualProvider] || 0) + entry.costUSD;

      if (entry.savedFromCache) {
        cacheSavingsTotal += calculateCost(entry.actualProvider, entry.actualModelId, entry.inputTokens, entry.outputTokens);
      }

      if (entry.costUSD === 0) {
        freeTierSavingsTotal += estimateFreeTierSavings(entry.inputTokens, entry.outputTokens);
      }
    }

    const totalRequests = entries.length;
    const avgCostPerRequest = totalRequests > 0 ? totalRevenue / totalRequests : 0;

    return {
      totalRevenue,
      totalTokens,
      totalRequests,
      uniqueUsers,
      costByAliasModel,        // Safe for users
      costByActualProvider,    // INTERNAL ONLY - never expose to users!
      avgCostPerRequest,
      cacheSavingsTotal,
      freeTierSavingsTotal
    };
  } catch (error) {
    console.error('[CostTracker] Error getting global cost stats:', error);
    return {
      totalRevenue: 0,
      totalTokens: 0,
      totalRequests: 0,
      uniqueUsers: 0,
      costByAliasModel: {},
      costByActualProvider: {},
      avgCostPerRequest: 0,
      cacheSavingsTotal: 0,
      freeTierSavingsTotal: 0
    };
  }
}

/**
 * Get top users by cost (admin)
 */
export async function getTopUsersByCost(
  limit: number = 10,
  startDate?: Date,
  endDate?: Date
): Promise<Array<{ userId: string; totalSpent: number; totalTokens: number; totalRequests: number }>> {
  try {
    await connectDB();

    const matchStage: any = {};
    if (startDate || endDate) {
      matchStage.timestamp = {};
      if (startDate) matchStage.timestamp.$gte = startDate;
      if (endDate) matchStage.timestamp.$lte = endDate;
    }

    const pipeline = [
      ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: '$userId',
          totalSpent: { $sum: '$costUSD' },
          totalTokens: { $sum: '$totalTokens' },
          totalRequests: { $sum: 1 }
        }
      },
      { $sort: { totalSpent: -1 as const } },
      { $limit: limit }
    ];

    const results = await CostEntryModel.aggregate(pipeline);

    return results.map(r => ({
      userId: r._id,
      totalSpent: r.totalSpent,
      totalTokens: r.totalTokens,
      totalRequests: r.totalRequests
    }));
  } catch (error) {
    console.error('[CostTracker] Error getting top users:', error);
    return [];
  }
}

/**
 * Get cost efficiency by model (cost per 1k tokens)
 */
export async function getModelEfficiency(): Promise<Array<{
  aliasModelId: string;
  avgCostPer1kTokens: number;
  totalRequests: number;
  totalCost: number;
}>> {
  try {
    await connectDB();

    const pipeline = [
      {
        $group: {
          _id: '$aliasModelId',
          totalCost: { $sum: '$costUSD' },
          totalTokens: { $sum: '$totalTokens' },
          totalRequests: { $sum: 1 }
        }
      },
      {
        $project: {
          aliasModelId: '$_id',
          totalCost: 1,
          totalRequests: 1,
          avgCostPer1kTokens: {
            $cond: [
              { $gt: ['$totalTokens', 0] },
              { $multiply: [{ $divide: ['$totalCost', '$totalTokens'] }, 1000] },
              0
            ]
          }
        }
      },
      { $sort: { avgCostPer1kTokens: 1 as const } }
    ];

    const results = await CostEntryModel.aggregate(pipeline);

    return results.map(r => ({
      aliasModelId: r.aliasModelId,
      avgCostPer1kTokens: r.avgCostPer1kTokens,
      totalRequests: r.totalRequests,
      totalCost: r.totalCost
    }));
  } catch (error) {
    console.error('[CostTracker] Error getting model efficiency:', error);
    return [];
  }
}

// ============== OPTIMIZATION RECOMMENDATIONS ==============

/**
 * Get cost optimization recommendations for a user
 */
export async function getCostOptimizationRecommendations(userId: string): Promise<string[]> {
  const summary = await getUserCostSummary(userId);
  const recommendations: string[] = [];

  // Check if using expensive models unnecessarily
  const proUsage = (summary.costByModel['alia-v1-pro'] || 0) + (summary.costByModel['alia-v1-pro-max'] || 0);
  const totalCost = summary.totalSpent;

  if (proUsage > totalCost * 0.5 && summary.totalRequests > 20) {
    recommendations.push('💡 You\'re using Pro models frequently. Consider using standard Alia V1 for simpler tasks to save costs.');
  }

  // Check cache usage
  if (summary.cacheSavings > 0) {
    recommendations.push(`✅ Great! Cache hits saved you $${summary.cacheSavings.toFixed(2)} this period.`);
  } else if (summary.totalRequests > 10) {
    recommendations.push('💡 You could save money by enabling response caching for repeated queries.');
  }

  // Check free tier savings
  if (summary.freeTierSavings > summary.totalSpent * 2) {
    recommendations.push(`🎉 Excellent! Free tier usage saved you $${summary.freeTierSavings.toFixed(2)} compared to paid-only models.`);
  }

  // Monthly projection
  if (summary.estimatedMonthlyCost > 50) {
    recommendations.push(`📊 Your projected monthly cost is $${summary.estimatedMonthlyCost.toFixed(2)}. Consider optimizing high-cost tasks.`);
  }

  return recommendations;
}

// ============== EXPORT FOR DASHBOARD ==============

export async function getUserDashboardData(userId: string): Promise<{
  summary: UserCostSummary;
  recommendations: string[];
  recentActivity: CostEntry[];
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [summary, recommendations, recentActivity] = await Promise.all([
    getUserCostSummary(userId, thirtyDaysAgo),
    getCostOptimizationRecommendations(userId),
    CostEntryModel.find({ userId })
      .sort({ timestamp: -1 })
      .limit(10)
      .lean()
  ]);

  return {
    summary,
    recommendations,
    recentActivity: recentActivity as CostEntry[]
  };
}
