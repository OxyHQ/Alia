import { Router } from 'express';
import { log } from '../../lib/logger.js';
import {
  getAliaModel,
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

function serializeModel(model: AliaModelWithAvailability, isDefault = false) {
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
    is_available: model.isAvailable,
    is_legacy: model.isLegacy,
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
 * - chat: If 'true', return only models marked as chatVisible (for the app's model selector)
 */
router.get('/', async (req, res) => {
  try {
    const category = req.query.category as ModelCategory | undefined;
    const chat = req.query.chat === 'true';

    // Get all models with availability status
    const allModelsWithAvailability = await getAvailableModels();

    let aliaModels = allModelsWithAvailability;
    if (chat) {
      aliaModels = aliaModels.filter(m => m.chatVisible);
    } else if (category) {
      aliaModels = aliaModels.filter(m => m.category === category);
    }

    const defaultModel = category ? await getDefaultModelForCategory(category) : null;

    const data = aliaModels.map(model =>
      serializeModel(model, model.id === defaultModel?.id)
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
  } catch (e: unknown) {
    log.v1.error({ err: e }, 'Error');
    res.status(500).json({
      error: {
        message: 'An internal error occurred while listing models.',
        type: 'server_error',
        param: null,
        code: null,
      }
    });
  }
});

/**
 * GET /v1/models/:modelId
 * Get a specific Alia model
 */
router.get('/:modelId', async (req, res) => {
  try {
    const model = await getAliaModel(req.params.modelId);

    if (!model) {
      res.status(404).json({
        error: {
          message: `The model '${req.params.modelId}' does not exist.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        }
      });
      return;
    }

    res.json(serializeModel({ ...model, isAvailable: true, isLegacy: false }));
  } catch (e: unknown) {
    log.v1.error({ err: e }, 'Error');
    res.status(500).json({
      error: {
        message: 'An internal error occurred while retrieving the model.',
        type: 'server_error',
        param: null,
        code: null,
      }
    });
  }
});

export default router;
