/**
 * Models Statistics API
 *
 * Provides aggregated statistics for Alia virtual models
 * NEVER exposes internal provider information!
 */

import { Router, Request, Response } from 'express';
import { getAllAliaModels, type AliaModel } from '../lib/chat-core.js';
import { TIER_MODEL_MAPPINGS } from '../internal/providers/lib/alia-models.js';
import { getProviderHealth } from '../internal/providers/lib/provider-health.js';
import { connectDB } from '../lib/db.js';
import mongoose from 'mongoose';
import { log } from '../lib/logger.js';

const router = Router();

interface ModelStats {
  id: string;
  name: string;
  description: string;
  tier: string;
  category: string;
  creditMultiplier: number;

  // Aggregated metrics (from all underlying providers)
  avgLatencyMs: number;
  uptime: number;              // 0-100 percentage
  successRate: number;         // 0-100 percentage
  totalRequests: number;
  isHealthy: boolean;

  // Capabilities
  supportsTools: boolean;
  supportsVision: boolean;
  maxTokens: number;
}

/**
 * GET /api/models/stats
 * Returns aggregated statistics for all Alia models
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const models = getAllAliaModels();
    const modelStats: ModelStats[] = [];

    for (const model of models) {
      // Get all provider mappings for this tier
      const mappings = TIER_MODEL_MAPPINGS[model.tier] || [];

      // Aggregate health metrics from all providers backing this model
      let totalLatency = 0;
      let totalSuccessRate = 0;
      let totalRequests = 0;
      let healthyProviders = 0;
      let totalProviders = 0;

      for (const mapping of mappings) {
        try {
          const health = await getProviderHealth(mapping.provider, mapping.modelId);

          totalProviders++;
          if (health.isHealthy) healthyProviders++;

          // Weight by request count for accurate averages
          if (health.totalRequests > 0) {
            totalLatency += health.averageLatencyMs * health.totalRequests;
            totalSuccessRate += health.successRate * health.totalRequests;
            totalRequests += health.totalRequests;
          }
        } catch (error) {
          log.models.error({ err: error, provider: mapping.provider }, 'Error getting health for provider');
        }
      }

      // Calculate weighted averages
      const avgLatencyMs = totalRequests > 0 ? totalLatency / totalRequests : 0;
      const successRate = totalRequests > 0 ? totalSuccessRate / totalRequests : 100;
      const uptime = totalProviders > 0 ? (healthyProviders / totalProviders) * 100 : 100;

      modelStats.push({
        id: model.id,
        name: model.name,
        description: model.description,
        tier: model.tier,
        category: model.category,
        creditMultiplier: model.creditMultiplier,
        avgLatencyMs: Math.round(avgLatencyMs),
        uptime: Math.round(uptime * 100) / 100,
        successRate: Math.round(successRate * 100) / 100,
        totalRequests,
        isHealthy: uptime >= 50 && successRate >= 50,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        maxTokens: model.maxTokens
      });
    }

    // Sort by category, then by tier
    modelStats.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category === 'general' ? -1 : 1;
      }
      return a.creditMultiplier - b.creditMultiplier;
    });

    res.json({
      models: modelStats,
      count: modelStats.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log.models.error({ err: error }, 'Error fetching model stats');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch model statistics'
      }
    });
  }
});

/**
 * GET /api/models/stats/:modelId
 * Returns detailed statistics for a specific Alia model
 */
router.get('/stats/:modelId', async (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const models = getAllAliaModels();
    const model = models.find(m => m.id === modelId);

    if (!model) {
      return res.status(404).json({
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${modelId}' not found`
        }
      });
    }

    // Get provider mappings
    const mappings = TIER_MODEL_MAPPINGS[model.tier] || [];

    // Aggregate metrics
    let totalLatency = 0;
    let totalSuccessRate = 0;
    let totalRequests = 0;
    let healthyProviders = 0;
    let totalProviders = 0;
    let lastSuccess: Date | null = null;
    let lastFailure: Date | null = null;

    for (const mapping of mappings) {
      try {
        const health = await getProviderHealth(mapping.provider, mapping.modelId);

        totalProviders++;
        if (health.isHealthy) healthyProviders++;

        if (health.totalRequests > 0) {
          totalLatency += health.averageLatencyMs * health.totalRequests;
          totalSuccessRate += health.successRate * health.totalRequests;
          totalRequests += health.totalRequests;
        }

        // Track most recent success/failure
        if (health.lastSuccess && (!lastSuccess || health.lastSuccess > lastSuccess)) {
          lastSuccess = health.lastSuccess;
        }
        if (health.lastFailure && (!lastFailure || health.lastFailure > lastFailure)) {
          lastFailure = health.lastFailure;
        }
      } catch (error) {
        log.models.error({ err: error, provider: mapping.provider }, 'Error getting health for provider');
      }
    }

    const avgLatencyMs = totalRequests > 0 ? totalLatency / totalRequests : 0;
    const successRate = totalRequests > 0 ? totalSuccessRate / totalRequests : 100;
    const uptime = totalProviders > 0 ? (healthyProviders / totalProviders) * 100 : 100;

    res.json({
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        tier: model.tier,
        category: model.category,
        creditMultiplier: model.creditMultiplier,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        maxTokens: model.maxTokens
      },
      stats: {
        avgLatencyMs: Math.round(avgLatencyMs),
        uptime: Math.round(uptime * 100) / 100,
        successRate: Math.round(successRate * 100) / 100,
        totalRequests,
        isHealthy: uptime >= 50 && successRate >= 50,
        lastSuccess: lastSuccess?.toISOString() || null,
        lastFailure: lastFailure?.toISOString() || null,
        backingProviders: totalProviders,
        healthyProviders: healthyProviders
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log.models.error({ err: error }, 'Error fetching model stats');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch model statistics'
      }
    });
  }
});

export default router;
