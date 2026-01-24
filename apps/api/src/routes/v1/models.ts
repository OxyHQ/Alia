import { Router } from 'express';
import { getAllAliaModels, getAliaModel, getAliaModelsByCategory, type ModelCategory } from '../../lib/alia-models.js';

const router = Router();

/**
 * GET /v1/models
 * List all available Alia models (OpenAI-compatible format)
 *
 * Query params:
 * - category: Filter by category ('coding' | 'general')
 */
router.get('/', async (req, res) => {
  try {
    const category = req.query.category as ModelCategory | undefined;
    const aliaModels = category ? getAliaModelsByCategory(category) : getAllAliaModels();

    const models = aliaModels.map(model => ({
      id: model.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'alia',
      permission: [],
      root: model.id,
      parent: null,
      // Alia-specific metadata
      name: model.name,
      description: model.description,
      category: model.category,
      capabilities: {
        tools: model.supportsTools,
        vision: model.supportsVision,
        max_tokens: model.maxTokens,
      },
      pricing: {
        credit_multiplier: model.creditMultiplier,
      },
    }));

    res.json({
      object: 'list',
      data: models,
    });
  } catch (e: any) {
    console.error('[V1/Models] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /v1/models/:modelId
 * Get a specific Alia model
 */
router.get('/:modelId', async (req, res) => {
  try {
    const model = getAliaModel(req.params.modelId);

    if (!model) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    res.json({
      id: model.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'alia',
      permission: [],
      root: model.id,
      parent: null,
      name: model.name,
      description: model.description,
      category: model.category,
      capabilities: {
        tools: model.supportsTools,
        vision: model.supportsVision,
        max_tokens: model.maxTokens,
      },
      pricing: {
        credit_multiplier: model.creditMultiplier,
      },
    });
  } catch (e: any) {
    console.error('[V1/Models] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
