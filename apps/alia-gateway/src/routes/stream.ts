/**
 * POST /api/stream
 * Single-hop streaming: resolve model -> stream from provider -> report usage
 * Eliminates 2 extra round-trips vs resolve+proxy+report
 */

import express, { Request, Response } from 'express';
import { resolveAliaModel } from '../lib/model-resolver.js';
import { providers } from '../lib/providers/index.js';
import type { Provider, ProviderConfig } from '../lib/types.js';
import {
  recordKeySuccess,
  recordKeyFailure,
  recordKeyUsage,
} from '../lib/key-manager.js';
import {
  recordSuccess,
  recordFailure,
} from '../lib/provider-health.js';
import { log } from '../lib/logger.js';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      model,
      messages,
      tools,
      config,
      skipProviders,
      skipKeyIds,
      estimatedTokens,
    } = req.body;

    // Validate required fields
    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'model is required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required',
        code: 'INVALID_REQUEST',
      });
    }

    // Step 1: Resolve model to concrete provider + key
    const skip = skipProviders ? new Set<string>(skipProviders) : new Set<string>();
    const skipKeys = skipKeyIds ? new Set<string>(skipKeyIds) : new Set<string>();
    const resolved = await resolveAliaModel(model, estimatedTokens ?? 1000, skip, skipKeys);

    if (!resolved) {
      return res.status(503).json({
        success: false,
        error: 'No providers available for this model',
        code: 'NO_PROVIDERS_AVAILABLE',
      });
    }

    // Step 2: Get provider adapter
    const providerImpl = providers[resolved.provider];
    if (!providerImpl) {
      return res.status(503).json({
        success: false,
        error: 'Resolved provider not available',
        code: 'PROVIDER_NOT_FOUND',
      });
    }

    // Step 3: Build provider config from request overrides
    const providerConfig: ProviderConfig | undefined = config
      ? {
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        }
      : undefined;

    // Step 4: Stream from provider
    const startTime = Date.now();
    const stream = await (providerImpl as Provider).proxy(
      resolved.keyConfig,
      messages,
      tools,
      providerConfig,
    );

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Alia-Model', resolved.aliasModelId);
    res.setHeader('X-Provider-Used', resolved.provider);
    res.setHeader('X-Model-Id', resolved.modelId);
    if (resolved.isFallback) {
      res.setHeader('X-Fallback-Index', String(resolved.fallbackIndex));
    }

    // Step 5: Pipe stream to response, then report
    const reader = stream.getReader();
    let totalTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);

        // Try to extract token count from usage data in the stream
        try {
          const text = new TextDecoder().decode(value);
          const match = text.match(/"usage":\s*\{\s*"total_tokens":\s*(\d+)/);
          if (match) {
            totalTokens = parseInt(match[1], 10);
          }
        } catch {
          // Ignore parsing errors in token extraction
        }
      }

      res.end();

      // Fire-and-forget: report success
      const latencyMs = Date.now() - startTime;
      const keyId = resolved.keyConfig.keyId;
      if (keyId) {
        Promise.all([
          recordKeySuccess(keyId),
          recordSuccess(resolved.provider, resolved.modelId, latencyMs),
          totalTokens > 0
            ? recordKeyUsage(keyId, totalTokens, resolved.provider, resolved.modelId)
            : Promise.resolve(),
        ]).catch((err: unknown) => {
          log.providers.warn({ err }, 'Failed to record stream success metrics');
        });
      }
    } catch (streamError: unknown) {
      const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
      log.providers.error({ err: streamError }, 'Stream error during single-hop streaming');

      // Fire-and-forget: report failure
      const keyId = resolved.keyConfig.keyId;
      if (keyId) {
        Promise.all([
          recordKeyFailure(keyId, `${resolved.modelId}: ${errorMessage}`),
          recordFailure(resolved.provider, resolved.modelId, errorMessage),
        ]).catch((err: unknown) => {
          log.providers.warn({ err }, 'Failed to record stream failure metrics');
        });
      }

      // If headers haven't been sent yet, return a JSON error
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Streaming error occurred',
          code: 'STREAMING_ERROR',
        });
      } else {
        // Headers already sent (streaming started), just end the response
        res.end();
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.providers.error({ err: error }, 'Error in single-hop stream endpoint');

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'An internal error occurred',
        code: 'INTERNAL_ERROR',
      });
    }
  }
});

export default router;
