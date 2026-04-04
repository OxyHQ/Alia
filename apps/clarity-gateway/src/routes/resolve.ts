/**
 * POST /api/resolve
 * Resolves a Clarity model to a concrete provider + key configuration.
 * Used by the main API before streaming chat completions.
 */

import express, { Request, Response } from 'express';
import { resolveClarityModel } from '../lib/model-resolver.js';
import { log } from '../lib/logger.js';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { model, estimatedTokens, skipProviders, skipKeyIds } = req.body;

    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'model is required',
        code: 'INVALID_REQUEST',
      });
    }

    const skip = skipProviders ? new Set<string>(skipProviders) : new Set<string>();
    const skipKeys = skipKeyIds ? new Set<string>(skipKeyIds) : new Set<string>();
    const resolved = await resolveClarityModel(model, estimatedTokens ?? 1000, skip, skipKeys);

    if (!resolved) {
      return res.status(503).json({
        success: false,
        error: 'No providers available for this model',
        code: 'NO_PROVIDERS_AVAILABLE',
      });
    }

    res.json({
      success: true,
      data: {
        keyConfig: resolved.keyConfig,
        provider: resolved.provider,
        modelId: resolved.modelId,
        clarityModelId: resolved.clarityModelId,
        isFallback: resolved.isFallback,
        clarityModel: resolved.clarityModel,
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error resolving model');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
