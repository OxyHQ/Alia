/**
 * Service-to-service data endpoints.
 * GET /api/models   — alia models, tier mappings, availability
 * GET /api/health   — provider health metrics
 * GET /api/billing  — plans, packages, features, entitlements
 */

import express, { Request, Response } from 'express';
import {
  getAllAliaModels,
  getAliaModel,
  isAliaModel,
  getModelMappingsForTier,
  getAvailableModels,
  TIER_MODEL_MAPPINGS,
  type AliaTier,
} from '../lib/alia-models.js';
import { getAllProviderHealth, getProviderHealth } from '../lib/provider-health.js';
import { Plan } from '../models/plan.js';
import { CreditPackage } from '../models/credit-package.js';
import { Feature } from '../models/feature.js';
import { PlanFeature } from '../models/plan-feature.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /api/models
 * Returns alia models with optional tier mappings and availability.
 * Query params:
 *   - tier: get mappings for specific tier
 *   - id: get a single model by ID
 *   - available: include availability status (slower, checks health)
 *   - tierMappings: include all tier-to-model mappings
 */
router.get('/models', async (req: Request, res: Response) => {
  try {
    const { tier, id, available, tierMappings } = req.query;

    // Single model lookup
    if (id && typeof id === 'string') {
      const model = getAliaModel(id);
      return res.json({
        success: true,
        data: { model, isAliaModel: isAliaModel(id) },
      });
    }

    // Tier mappings for a specific tier
    if (tier && typeof tier === 'string') {
      const mappings = getModelMappingsForTier(tier as AliaTier);
      return res.json({
        success: true,
        data: { tier, mappings },
      });
    }

    // Full model list
    const models = available === 'true'
      ? await getAvailableModels()
      : getAllAliaModels();

    const response: any = { success: true, data: { models } };

    if (tierMappings === 'true') {
      response.data.tierMappings = TIER_MODEL_MAPPINGS;
    }

    res.json(response);
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting models');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /api/health
 * Provider health metrics.
 * Query params:
 *   - provider + modelId: specific provider health
 *   - (none): all provider health
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.query;

    if (provider && modelId && typeof provider === 'string' && typeof modelId === 'string') {
      const health = await getProviderHealth(provider, modelId);
      return res.json({ success: true, data: health });
    }

    const allHealth = await getAllProviderHealth();
    res.json({ success: true, data: allHealth });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting provider health');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /api/billing
 * Read-only billing data: plans, packages, features, entitlements.
 * Query params:
 *   - type: 'plans' | 'packages' | 'features' | 'plan-features' | 'all'
 *   - active: filter by active status (for packages)
 *   - planId: filter plan-features by plan
 */
router.get('/billing', async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) || 'all';
    const active = req.query.active as string;
    const planId = req.query.planId as string;

    const response: any = { success: true, data: {} };

    if (type === 'plans' || type === 'all') {
      response.data.plans = await Plan.find({}).sort({ sortOrder: 1 }).lean();
    }

    if (type === 'packages' || type === 'all') {
      const query: any = {};
      if (active !== undefined) query.isActive = active === 'true';
      response.data.packages = await CreditPackage.find(query).sort({ sortOrder: 1 }).lean();
    }

    if (type === 'features' || type === 'all') {
      response.data.features = await Feature.find({}).sort({ category: 1, sortOrder: 1 }).lean();
    }

    if (type === 'plan-features' || type === 'all') {
      const pfQuery: any = {};
      if (planId) pfQuery.planId = planId;
      response.data.planFeatures = await PlanFeature.find(pfQuery).lean();
    }

    res.json(response);
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting billing data');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
