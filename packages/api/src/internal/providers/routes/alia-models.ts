/**
 * Alia Models API Routes (Admin Only)
 * Handles virtual Alia model management with provider mappings
 */

import express, { Request, Response } from 'express';
import { AliaModel } from '../models/alia-model';
import { ModelConfig } from '../models/model-config';
import { broadcastAliaModelsUpdate } from '../lib/broadcast-helpers';
import { log } from '../../../lib/logger.js';

const router = express.Router();

// Valid tier names
const VALID_TIERS = [
  'lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser',
  'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max',
  'v1-voice', 'v1-voice-pro',
];

/**
 * GET /v1/alia-models
 * List all Alia virtual models
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { tier, active } = req.query;

    const query: Record<string, unknown> = {};
    if (tier && typeof tier === 'string') query.tier = tier;
    if (active !== undefined) query.isActive = active === 'true';

    const models = await AliaModel.find(query).sort({ tier: 1, aliasModelId: 1 });

    res.json({
      success: true,
      count: models.length,
      data: models,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing alia models');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/alia-models/:aliasModelId
 * Get specific Alia model with its provider mappings
 */
router.get('/:aliasModelId', async (req: Request, res: Response) => {
  try {
    const { aliasModelId } = req.params;

    const model = await AliaModel.findOne({ aliasModelId });

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Alia model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting alia model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/alia-models
 * Create new Alia virtual model
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { aliasModelId, displayName, tier, description, features, creditMultiplier, isFreeTier, aggregatedCapabilities, providerMappings } = req.body;

    if (!aliasModelId || !displayName || !tier) {
      return res.status(400).json({
        success: false,
        error: 'aliasModelId, displayName, and tier are required',
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
    const existing = await AliaModel.findOne({ aliasModelId: aliasModelId.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Alia model with this ID already exists',
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

    const model = await AliaModel.create({
      aliasModelId: aliasModelId.toLowerCase(),
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

    void broadcastAliaModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating alia model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/alia-models/:aliasModelId
 * Update Alia model configuration
 */
router.patch('/:aliasModelId', async (req: Request, res: Response) => {
  try {
    const { aliasModelId } = req.params;
    const updates = req.body;

    // Don't allow changing aliasModelId
    delete updates.aliasModelId;

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

    const model = await AliaModel.findOneAndUpdate(
      { aliasModelId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Alia model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });

    void broadcastAliaModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating alia model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/alia-models/:aliasModelId
 * Delete Alia virtual model
 */
router.delete('/:aliasModelId', async (req: Request, res: Response) => {
  try {
    const { aliasModelId } = req.params;

    const model = await AliaModel.findOneAndDelete({ aliasModelId });

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Alia model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Alia model deleted successfully',
    });

    void broadcastAliaModelsUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting alia model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
