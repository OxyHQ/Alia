/**
 * Models API Routes
 * Handles model configuration management
 */

import express, { Request, Response } from 'express';
import {
  createModelConfig,
  deleteModelConfig,
  findModelConfig,
  listModelConfigs,
  listModelConfigsForTier,
  updateModelConfig,
} from '../../../db/providers/modelConfigRepository.js';
import { getDb } from '../../../db/index.js';
import { broadcastModelsUpdate } from '../lib/broadcast-helpers';
import { getErrorMessage } from '../../../lib/errors/index.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

/**
 * GET /v1/models
 * List all model configurations with optional filtering
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { provider, aliaTier, active, deprecated } = req.query;

    // Build query
    const models = await listModelConfigs(getDb(), {
      provider: typeof provider === 'string' ? provider : undefined,
      aliaTier: typeof aliaTier === 'string' ? aliaTier : undefined,
      isActive: active === undefined ? undefined : active === 'true',
      isDeprecated: deprecated === undefined ? undefined : deprecated === 'true',
    });

    res.json({
      success: true,
      count: models.length,
      data: models,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error listing models');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/models/by-tier/:tier
 * Get all models for a specific Alia tier
 */
router.get('/by-tier/:tier', async (req: Request, res: Response) => {
  try {
    const { tier } = req.params;

    const models = await listModelConfigsForTier(getDb(), String(tier));

    res.json({
      success: true,
      tier,
      count: models.length,
      data: models,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error getting models by tier');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/models/:provider/:modelId
 * Get specific model configuration
 */
router.get('/:provider/:modelId', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.params;

    const model = await findModelConfig(getDb(), String(provider), String(modelId));

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error getting model');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/models
 * Create new model configuration (admin only)
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const modelData = req.body;

    // Check if model already exists
    const existing = await findModelConfig(getDb(), modelData.provider, modelData.modelId);

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Model already exists',
        code: 'MODEL_ALREADY_EXISTS',
      });
    }

    // Create new model
    const model = await createModelConfig(getDb(), modelData);

    res.status(201).json({
      success: true,
      data: model,
    });

    void broadcastModelsUpdate(modelData.provider);
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error creating model');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/models/:provider/:modelId
 * Update model configuration (admin only)
 */
router.patch('/:provider/:modelId', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.params;
    const updates = req.body;

    // Don't allow changing provider or modelId
    delete updates.provider;
    delete updates.modelId;

    const model = await updateModelConfig(getDb(), String(provider), String(modelId), updates);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: model,
    });

    void broadcastModelsUpdate(provider as string);
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error updating model');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/models/:provider/:modelId
 * Delete model configuration (admin only)
 */
router.delete('/:provider/:modelId', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.params;

    const model = await deleteModelConfig(getDb(), String(provider), String(modelId));

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found',
        code: 'MODEL_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Model deleted successfully',
    });

    void broadcastModelsUpdate(provider as string);
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error deleting model');
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
