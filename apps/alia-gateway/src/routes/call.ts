/**
 * POST /api/call
 * End-to-end non-streaming provider API call.
 * Handles key rotation, retries, and error classification internally.
 * Used for images, embeddings, transcription, etc.
 */

import express, { Request, Response } from 'express';
import { callProviderAPI } from '../lib/provider-api.js';
import { log } from '../lib/logger.js';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { provider, modelId, endpoint, body, audio, extraFormFields, maxAttempts, timeout } = req.body;

    if (!provider || !modelId || !endpoint) {
      return res.status(400).json({
        success: false,
        error: 'provider, modelId, and endpoint are required',
        code: 'INVALID_REQUEST',
      });
    }

    // If audio is provided, reconstruct FormData server-side
    let formData: FormData | undefined;
    if (audio?.base64) {
      const buffer = Buffer.from(audio.base64, 'base64');
      const blob = new Blob([buffer], { type: audio.mimeType || 'audio/webm' });
      formData = new FormData();
      formData.append('file', blob, audio.filename || 'audio.webm');

      // Append extra form fields (e.g., model name)
      if (extraFormFields) {
        for (const [key, value] of Object.entries(extraFormFields)) {
          formData.append(key, value as string);
        }
      }
    }

    const data = await callProviderAPI({
      provider,
      modelId,
      endpoint,
      body: formData ? undefined : body,
      formData,
      maxAttempts: maxAttempts ?? 3,
      timeout: timeout ?? 30000,
    });

    res.json({ success: true, data });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Provider API call failed');
    res.status(502).json({
      success: false,
      error: error.message || 'Provider API call failed',
      reason: error.reason || 'unknown',
      code: 'PROVIDER_ERROR',
    });
  }
});

export default router;
