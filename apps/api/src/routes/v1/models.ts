import { Router } from 'express';
import {
  getAllAliaModels,
  getAliaModel,
  getAliaModelsByCategory,
  getDefaultModelForCategory,
  getAvailableModels,
  type ModelCategory,
  type AliaModelWithAvailability,
} from '../../lib/chat-core.js';

const router = Router();

function getRequiredPlan(creditMultiplier: number): string | null {
  if (creditMultiplier <= 1.0) return null;
  if (creditMultiplier <= 2.0) return 'Go';
  return 'Pro';
}

function serializeModel(model: ReturnType<typeof getAliaModel> & {}, isDefault = false, isAvailable = true) {
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'alia',
    name: model.name,
    description: model.description,
    category: model.category,
    emoji: model.emoji,
    is_default: isDefault,
    is_available: isAvailable,
    required_plan: getRequiredPlan(model.creditMultiplier),
    capabilities: {
      tools: model.supportsTools,
      vision: model.supportsVision,
      max_tokens: model.maxTokens,
    },
    pricing: {
      credit_multiplier: model.creditMultiplier,
    },
  };
}

/**
 * GET /v1/models
 * List available Alia models with live availability status
 *
 * Query params:
 * - category: Filter by category ('general' | 'coding' | 'vision' | 'audio' | 'multimodal' | 'voice')
 */
router.get('/', async (req, res) => {
  try {
    const category = req.query.category as ModelCategory | undefined;

    // Get all models with availability status
    const allModelsWithAvailability = await getAvailableModels();

    const aliaModels = category
      ? allModelsWithAvailability.filter(m => m.category === category)
      : allModelsWithAvailability;

    const defaultModel = category ? getDefaultModelForCategory(category) : null;

    const data = aliaModels.map(model =>
      serializeModel(model, model.id === defaultModel?.id, model.isAvailable)
    );

    // Sort: default first, then by credit multiplier
    data.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return a.pricing.credit_multiplier - b.pricing.credit_multiplier;
    });

    res.json({
      object: 'list',
      data,
      ...(category && { category }),
      ...(defaultModel && { default_model: defaultModel.id }),
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

    res.json(serializeModel(model));
  } catch (e: any) {
    console.error('[V1/Models] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
