/**
 * Providers API Routes
 * Handles model resolution, provider proxying, and health monitoring
 */

import express, { Request, Response } from 'express';
import { providers } from '../lib/providers';
import type { Provider } from '../lib/types';
import { resolveAliaModel } from '../lib/model-resolver';
import {
  getProviderHealth,
  getAllProviderHealth,
  recordSuccess,
  recordFailure,
  isProviderAvailable,
  resetProviderHealth
} from '../lib/provider-health';
import mongoose from 'mongoose';
import { getBestKeyForModel, recordKeyUsage, recordKeySpend } from '../lib/key-manager';
import { sanitizeError } from '../../../lib/error-handler.js';
import { broadcastHealthUpdate } from '../lib/broadcast-helpers';
import { calculateCost } from '../../../lib/cost-tracker.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

/**
 * POST /v1/providers/resolve
 * Resolve an Alia model to a concrete provider/model
 */
router.post('/resolve', async (req: Request, res: Response) => {
  try {
    const { aliasModelId, estimatedTokens = 0, skipProviders = [], keyPreference = {} } = req.body;

    if (!aliasModelId) {
      return res.status(400).json({
        success: false,
        error: 'aliasModelId is required',
        code: 'INVALID_REQUEST',
      });
    }

    // Resolve the model
    const skipSet = new Set<string>(skipProviders);
    const resolved = await resolveAliaModel(aliasModelId, estimatedTokens, skipSet);

    if (!resolved) {
      return res.status(503).json({
        success: false,
        error: 'No available providers for this model',
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    // Get the model configuration from the resolution
    const modelConfig = resolved.aliaModel;

    res.json({
      success: true,
      data: {
        aliasModelId: resolved.aliasModelId,
        provider: resolved.provider,
        modelId: resolved.modelId,
        keyId: resolved.keyConfig?.keyId || null,
        keyPrefix: resolved.keyConfig?.key?.substring(0, 8) + '...' || null,
        isFallback: resolved.isFallback,
        fallbackIndex: resolved.fallbackIndex,
        capabilities: {
          vision: modelConfig.supportsVision || false,
          tools: modelConfig.supportsTools || false,
        },
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error resolving model');
    res.status(500).json({
      success: false,
      error: sanitizeError(error.message),
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/providers/:provider/proxy
 * Proxy a request to a specific provider
 */
router.post('/:provider/proxy', async (req: Request, res: Response) => {
  try {
    const provider = req.params.provider as string;
    const { modelId, messages, tools, config, keyPreference = {} } = req.body;

    // Validate inputs
    if (!modelId || !messages || !Array.isArray(messages)) {
      return res.status(400).json({
        success: false,
        error: 'modelId and messages are required',
        code: 'INVALID_REQUEST',
      });
    }

    // Check if provider exists
    const providerImpl = providers[provider];
    if (!providerImpl) {
      return res.status(404).json({
        success: false,
        error: `Provider '${provider}' not found`,
        code: 'PROVIDER_NOT_FOUND',
      });
    }

    // Check provider health
    const available = await isProviderAvailable(provider, modelId);
    if (!available) {
      return res.status(503).json({
        success: false,
        error: 'Provider temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    // Get best available key
    const estimatedTokens = messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4;
    const keyConfig = await getBestKeyForModel(provider, modelId, estimatedTokens);

    if (!keyConfig) {
      return res.status(429).json({
        success: false,
        error: 'No available API keys (rate limited)',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Proxy the request to the provider
    const startTime = Date.now();
    const stream = await (providerImpl as Provider).proxy(keyConfig, messages, tools, config);

    // Set headers for streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Provider-Used', provider);
    res.setHeader('X-Key-Used', keyConfig.key.substring(0, 8) + '...');

    // Pipe the provider stream to the response
    const reader = stream.getReader();
    let totalTokens = 0;
    let success = true;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Write chunk to response
        res.write(value);

        // Try to extract token count from chunk (if it's usage data)
        try {
          const text = new TextDecoder().decode(value);
          const match = text.match(/"usage":\s*{\s*"total_tokens":\s*(\d+)/);
          if (match) {
            totalTokens = parseInt(match[1], 10);
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }

      res.end();
    } catch (streamError: any) {
      success = false;
      log.providers.error({ err: streamError }, 'Stream error');

      // Record failure
      await recordFailure(provider, modelId, streamError.message);

      // Send error to client if response not ended
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: sanitizeError(streamError.message),
          code: 'STREAMING_ERROR',
        });
      }
    }

    // Record metrics
    const latency = Date.now() - startTime;
    if (success) {
      await recordSuccess(provider, modelId, latency);
    }

    // Record key usage
    if (totalTokens > 0 && keyConfig.keyId) {
      await recordKeyUsage(keyConfig.keyId, totalTokens, provider, modelId);

      // Record key spend (fire and forget)
      const estimatedInputTokens = estimatedTokens;
      const estimatedOutputTokens = Math.max(0, totalTokens - estimatedInputTokens);
      const costUSD = calculateCost(provider, modelId, estimatedInputTokens, estimatedOutputTokens);
      recordKeySpend(keyConfig.keyId, costUSD);
    }

  } catch (error: any) {
    log.providers.error({ err: error }, 'Error proxying request');

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: sanitizeError(error.message),
        code: 'INTERNAL_ERROR',
      });
    }
  }
});

/**
 * GET /v1/providers/health
 * Get health status for all providers or specific provider/model
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const provider = req.query.provider as string | undefined;
    const modelId = req.query.modelId as string | undefined;

    if (provider && modelId) {
      // Get specific provider/model health
      const health = await getProviderHealth(provider, modelId);
      res.json({
        success: true,
        data: health,
      });
    } else {
      // Get all provider health
      const allHealth = await getAllProviderHealth();
      res.json({
        success: true,
        data: allHealth,
      });
    }
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting health');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/providers/health/record
 * Record success/failure for health monitoring
 */
router.post('/health/record', async (req: Request, res: Response) => {
  try {
    const { provider, modelId, success, latencyMs, errorCode } = req.body;

    if (!provider || !modelId || success === undefined) {
      return res.status(400).json({
        success: false,
        error: 'provider, modelId, and success are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (success) {
      await recordSuccess(provider, modelId, latencyMs || 0);
    } else {
      await recordFailure(provider, modelId, errorCode);
    }

    // Get updated health
    const health = await getProviderHealth(provider, modelId);

    res.json({
      success: true,
      data: {
        recorded: true,
        newCircuitState: health.circuitState,
        currentSuccessRate: health.successRate,
      },
    });

    broadcastHealthUpdate(provider, modelId);
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error recording health');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/providers/available
 * Check if a provider is available (circuit breaker status)
 */
router.get('/available', async (req: Request, res: Response) => {
  try {
    const provider = req.query.provider as string | undefined;
    const modelId = req.query.modelId as string | undefined;

    if (!provider || !modelId) {
      return res.status(400).json({
        success: false,
        error: 'provider and modelId are required',
        code: 'INVALID_REQUEST',
      });
    }

    const available = await isProviderAvailable(provider, modelId);

    res.json({
      success: true,
      data: {
        provider,
        modelId,
        available,
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error checking availability');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/providers/health/reset-all
 * Reset all provider health records (clear circuit breakers)
 */
router.post('/health/reset-all', async (req: Request, res: Response) => {
  try {
    const ProviderHealth = mongoose.models.ProviderHealth;
    if (!ProviderHealth) {
      return res.status(500).json({
        success: false,
        error: 'ProviderHealth model not available',
        code: 'INTERNAL_ERROR',
      });
    }

    const result = await ProviderHealth.updateMany(
      {},
      {
        $set: {
          successCount: 0,
          failureCount: 0,
          totalRequests: 0,
          successRate: 100,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          circuitState: 'closed',
          circuitOpenedAt: null,
          halfOpenAttempts: 0,
          isHealthy: true,
          lastHealthCheck: new Date(),
        },
      }
    );

    res.json({
      success: true,
      data: {
        resetCount: result.modifiedCount,
        message: 'All provider health records reset to healthy state',
      },
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error resetting all health');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/providers/health/reset
 * Reset health for a specific provider/model
 */
router.post('/health/reset', async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.body;

    if (!provider || !modelId) {
      return res.status(400).json({
        success: false,
        error: 'provider and modelId are required',
        code: 'INVALID_REQUEST',
      });
    }

    await resetProviderHealth(provider, modelId);
    const health = await getProviderHealth(provider, modelId);

    res.json({
      success: true,
      data: health,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error resetting health');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
