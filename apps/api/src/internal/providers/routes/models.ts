/**
 * Models API Routes
 * Handles model configuration management
 */

import express, { Request, Response } from 'express';
import { ModelConfig } from '../models/model-config';

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
    const query: any = {};
    if (provider) query.provider = provider;
    if (aliaTier) query.aliaTier = aliaTier;
    if (active !== undefined) query.isActive = active === 'true';
    if (deprecated !== undefined) query.isDeprecated = deprecated === 'true';

    // Execute query
    const models = await ModelConfig.find(query).sort({ provider: 1, priority: 1 });

    res.json({
      success: true,
      count: models.length,
      data: models,
    });
  } catch (error: any) {
    console.error('Error listing models:', error);
    res.status(500).json({
      success: false,
      error: error.message,
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

    const model = await ModelConfig.findOne({ provider, modelId });

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
  } catch (error: any) {
    console.error('Error getting model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
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
    const existing = await ModelConfig.findOne({
      provider: modelData.provider,
      modelId: modelData.modelId,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Model already exists',
        code: 'MODEL_ALREADY_EXISTS',
      });
    }

    // Create new model
    const model = await ModelConfig.create(modelData);

    res.status(201).json({
      success: true,
      data: model,
    });
  } catch (error: any) {
    console.error('Error creating model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
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

    const model = await ModelConfig.findOneAndUpdate(
      { provider, modelId },
      { $set: updates },
      { new: true, runValidators: true }
    );

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
  } catch (error: any) {
    console.error('Error updating model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
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

    const model = await ModelConfig.findOneAndDelete({ provider, modelId });

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
  } catch (error: any) {
    console.error('Error deleting model:', error);
    res.status(500).json({
      success: false,
      error: error.message,
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

    const models = await ModelConfig.find({
      aliaTier: tier,
      isActive: true,
      isDeprecated: false,
    }).sort({ priority: 1 });

    res.json({
      success: true,
      tier,
      count: models.length,
      data: models,
    });
  } catch (error: any) {
    console.error('Error getting models by tier:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
