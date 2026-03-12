import { Router } from 'express';
import { getModelMappingsForTier, callProviderAPI } from '../../lib/gateway-client.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { log } from '../../lib/logger.js';
import { sanitizeMessage } from '../../lib/errors/sanitize.js';
import type { Request, Response } from 'express';

const router = Router();
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

/**
 * POST /v1/images/generations
 * OpenAI-compatible image generation endpoint with provider fallback.
 *
 * Body: { prompt, n?, size?, quality?, response_format? }
 * Returns: { data: [{ url: string }] }
 */
router.post('/generations', async (req: Request, res: Response) => {
  const TIMEOUT_MS = 60_000;
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort('Image gen global timeout'), TIMEOUT_MS);

  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { prompt, n, size, quality, response_format } = req.body as {
      prompt?: string;
      n?: number;
      size?: string;
      quality?: string;
      response_format?: string;
    };

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Prompt is required', type: 'invalid_request_error' } });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({ error: { message: 'Prompt exceeds 4000 character limit', type: 'invalid_request_error' } });
    }

    // Ensure user has credits
    await getOrCreateUserCredits(userId);
    const reservation = await reserveCredits(userId);
    if (!reservation) {
      return res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: "You've run out of credits. Add more or upgrade your plan to continue.",
          retryable: false,
          suggestedAction: 'upgrade',
          details: { limitType: 'credits' },
        },
      });
    }

    // Resolve image provider via tier mappings — try each in priority order
    const imageMappings = await getModelMappingsForTier('v1-image');
    let imageUrl: string | null = null;

    for (const mapping of imageMappings) {
      if (abortController.signal.aborted) break;
      try {
        const data = await callProviderAPI<any>({
          provider: mapping.provider,
          modelId: mapping.modelId,
          endpoint: '/v1/images/generations',
          body: {
            model: mapping.modelId,
            prompt,
            n: n || 1,
            size: size || '1024x1024',
            quality: quality || 'standard',
            response_format: response_format || 'url',
          },
          timeout: 30_000,
          maxAttempts: 1,
          signal: abortController.signal,
        });

        // Different providers return images in different formats
        imageUrl = data.data?.[0]?.url ?? data?.images?.[0]?.url ?? null;
        const b64 = data.data?.[0]?.b64_json;

        if (b64) {
          // Upload b64 to S3 for a permanent URL
          const buffer = Buffer.from(b64, 'base64');
          imageUrl = await uploadToS3(buffer, 'image.png', `images/${userId}`, 'generated');
        }

        if (imageUrl) break;
      } catch (err: unknown) {
        log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'Image provider failed, trying next');
        continue;
      }
    }

    if (!imageUrl) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'Image generation failed — please try again', type: 'server_error' } });
    }

    // Charge credits for image generation (~5 credits per image)
    await finalizeCredits(reservation, {
      promptTokens: 250,
      completionTokens: 0,
      totalTokens: 250,
    });

    res.json({ data: [{ url: imageUrl }] });
  } catch (error: unknown) {
    const timedOut = abortController.signal.aborted;
    log.general.error({ err: error, userId: req.user?.id, timedOut }, 'Image generation failed');
    const status = timedOut ? 504 : 500;
    res.status(status).json({ error: { message: getSafeErrorMessage(error, 'Image generation failed'), type: 'server_error' } });
  } finally {
    clearTimeout(globalTimer);
  }
});

export default router;
