/**
 * Models API
 *
 * Returns available Alia models filtered by application type.
 * NEVER exposes internal provider information!
 */

import { Router, Request, Response } from 'express';
import { getAllAliaModels, type AliaModel } from '../lib/alia-models.js';

const router = Router();

export type AppType = 'main' | 'codea' | 'cowork' | 'browser';

/**
 * Filter models based on application type
 */
function filterModelsForApp(models: AliaModel[], appType: AppType): AliaModel[] {
  switch (appType) {
    case 'main':
      // Main Alia app: General models + multimodal capabilities
      return models.filter(m =>
        m.category === 'general' ||
        ['alia-v1-vision', 'alia-v1-audio', 'alia-v1-multimodal'].includes(m.id)
      );

    case 'codea':
      // Codea: Only coding models
      return models.filter(m =>
        m.category === 'coding' &&
        ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking'].includes(m.id)
      );

    case 'cowork':
      // Cowork: Coding models + vision (for desktop automation)
      return models.filter(m =>
        ['alia-v1-cowork', 'alia-v1-vision', 'alia-v1-pro'].includes(m.id)
      );

    case 'browser':
      // Browser: Browser automation model
      return models.filter(m =>
        m.id === 'alia-v1-browser'
      );

    default:
      // Default: return general models
      return models.filter(m => m.category === 'general');
  }
}

/**
 * Transform model for frontend consumption
 * STRIPS all internal information (provider mappings, etc.)
 */
function sanitizeModelForFrontend(model: AliaModel) {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    tier: model.tier,
    category: model.category,
    creditMultiplier: model.creditMultiplier,
    maxTokens: model.maxTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    // NEVER include: provider mappings, actual model IDs, etc.
  };
}

/**
 * GET /api/v1/models
 * Returns available models for the requesting application
 *
 * Query params:
 * - app: 'main' | 'codea' | 'cowork' | 'browser'
 * - category: 'general' | 'coding' (optional additional filter)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const appType = (req.query.app as AppType) || 'main';
    const category = req.query.category as 'general' | 'coding' | undefined;

    // Get all Alia models
    let models = getAllAliaModels();

    // Filter by app type
    models = filterModelsForApp(models, appType);

    // Optional: filter by category
    if (category) {
      models = models.filter(m => m.category === category);
    }

    // Sanitize for frontend (remove all internal details)
    const sanitizedModels = models.map(sanitizeModelForFrontend);

    // Sort by credit multiplier (cheapest first)
    sanitizedModels.sort((a, b) => a.creditMultiplier - b.creditMultiplier);

    res.json({
      models: sanitizedModels,
      app: appType,
      count: sanitizedModels.length
    });
  } catch (error) {
    console.error('[ModelsAPI] Error fetching models:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch available models'
      }
    });
  }
});

/**
 * GET /api/v1/models/:modelId
 * Get details for a specific model
 */
router.get('/:modelId', (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const models = getAllAliaModels();
    const model = models.find(m => m.id === modelId);

    if (!model) {
      return res.status(404).json({
        error: {
          code: 'INVALID_MODEL',
          message: `Model '${modelId}' not found`
        }
      });
    }

    // Sanitize for frontend
    const sanitized = sanitizeModelForFrontend(model);

    res.json({ model: sanitized });
  } catch (error) {
    console.error('[ModelsAPI] Error fetching model:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch model details'
      }
    });
  }
});

export default router;
