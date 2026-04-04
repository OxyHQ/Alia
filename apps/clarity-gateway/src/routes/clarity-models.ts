/**
 * Clarity Models API Routes (Admin Only)
 * Handles virtual Clarity model management with provider mappings
 */

import express, { Request, Response } from 'express';
import { ClarityModel } from '../models/clarity-model.js';
import { ModelConfig } from '../models/model-config.js';
import { broadcastClarityModelsUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../lib/logger.js';

const router = express.Router();

// Valid tier names
const VALID_TIERS = [
  'lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser',
  'v1-vision', 'v1-audio', 'v1-multimodal', 'v1-pro', 'v1-pro-max',
  'v1-voice', 'v1-voice-pro',
];

/**
 * GET /v1/clarity-models
 * List all Clarity virtual models
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { tier, active } = req.query;

    const query: any = {};
    if (tier && typeof tier === 'string') query.tier = tier;
    if (active !== undefined) query.isActive = active === 'true';

    const models = await ClarityModel.find(query).sort({ tier: 1, clarityModelId: 1 });

    res.json({
      success: true,
      count: models.length,
      data: models,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error listing Clarity models');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/clarity-models/:clarityModelId
 * Get specific Clarity model with its provider mappings
 */
router.get('/:clarityModelId', async (req: Request, res: Response) => {
  try {
    const { clarityModelId } = req.params;

    const model = await ClarityModel.findOne({ clarityModelId });

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/clarity-models
 * Create new Clarity virtual model
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { clarityModelId, displayName, tier, description, features, creditMultiplier, isFreeTier, aggregatedCapabilities, providerMappings } = req.body;

    if (!clarityModelId || !displayName || !tier) {
      return res.status(400).json({
        success: false,
        error: 'clarityModelId, displayName, and tier are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({
        success: false,
        error: `tier must be one of: ${VALID_TIERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    // Check for duplicate
    const existing = await ClarityModel.findOne({ clarityModelId: clarityModelId.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Clarity model with this ID already exists',
        code: 'MODEL_ALREADY_EXISTS',
      });
    }

    // Validate provider mappings if provided
    if (providerMappings && Array.isArray(providerMappings)) {
      for (const mapping of providerMappings) {
        if (!mapping.provider || !mapping.modelId || mapping.priority === undefined) {
          return res.status(400).json({
            success: false,
            error: 'Each provider mapping requires provider, modelId, and priority',
            code: 'INVALID_REQUEST',
          });
        }
        // Resolve modelConfigId from provider model
        const modelConfig = await ModelConfig.findOne({ provider: mapping.provider, modelId: mapping.modelId });
        if (!modelConfig) {
          return res.status(400).json({
            success: false,
            error: `Provider model not found: ${mapping.provider}/${mapping.modelId}. Add it as a provider model first.`,
            code: 'PROVIDER_MODEL_NOT_FOUND',
          });
        }
        mapping.modelConfigId = modelConfig._id;
      }
    }

    const model = await ClarityModel.create({
      clarityModelId: clarityModelId.toLowerCase(),
      displayName,
      tier,
      description,
      features: features || [],
      creditMultiplier: creditMultiplier || 1.0,
      isFreeTier: isFreeTier !== undefined ? isFreeTier : true,
      aggregatedCapabilities: aggregatedCapabilities || {},
      providerMappings: providerMappings || [],
    });

    res.status(201).json({
      success: true,
      data: model,
    });

    broadcastClarityModelsUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error creating Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/clarity-models/:clarityModelId
 * Update Clarity model configuration
 */
router.patch('/:clarityModelId', async (req: Request, res: Response) => {
  try {
    const { clarityModelId } = req.params;
    const updates = req.body;

    // Don't allow changing clarityModelId
    delete updates.clarityModelId;

    // Validate tier if being updated
    if (updates.tier && !VALID_TIERS.includes(updates.tier)) {
      return res.status(400).json({
        success: false,
        error: `tier must be one of: ${VALID_TIERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    // Validate provider mappings if being updated
    if (updates.providerMappings && Array.isArray(updates.providerMappings)) {
      for (const mapping of updates.providerMappings) {
        if (!mapping.provider || !mapping.modelId || mapping.priority === undefined) {
          return res.status(400).json({
            success: false,
            error: 'Each provider mapping requires provider, modelId, and priority',
            code: 'INVALID_REQUEST',
          });
        }
        // Resolve modelConfigId if not set
        if (!mapping.modelConfigId) {
          const modelConfig = await ModelConfig.findOne({ provider: mapping.provider, modelId: mapping.modelId });
          if (!modelConfig) {
            return res.status(400).json({
              success: false,
              error: `Provider model not found: ${mapping.provider}/${mapping.modelId}. Add it as a provider model first.`,
              code: 'PROVIDER_MODEL_NOT_FOUND',
            });
          }
          mapping.modelConfigId = modelConfig._id;
        }
      }
    }

    const model = await ClarityModel.findOneAndUpdate(
      { clarityModelId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });

    broadcastClarityModelsUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error updating Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/clarity-models/:clarityModelId
 * Delete Clarity virtual model
 */
router.delete('/:clarityModelId', async (req: Request, res: Response) => {
  try {
    const { clarityModelId } = req.params;

    const model = await ClarityModel.findOneAndDelete({ clarityModelId });

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Clarity model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Clarity model deleted successfully',
    });

    broadcastClarityModelsUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error deleting Clarity model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
