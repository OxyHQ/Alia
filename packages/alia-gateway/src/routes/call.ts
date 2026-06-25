/**
 * POST /api/call
 * End-to-end non-streaming provider API call.
 * Handles key rotation, retries, and error classification internally.
 * Used for images, embeddings, transcription, etc.
 */

import express, { Request, Response } from 'express';
import { callAliaModelAPI, callProviderAPI } from '../lib/provider-api.js';
import { log } from '../lib/logger.js';
import { errorMessage } from '../lib/error-handler.js';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { provider, modelId, model, endpoint, body, audio, extraFormFields, maxAttempts, timeout, responseType, maxProviderAttempts } = req.body;

    if (!endpoint) {
      return res.status(400).json({
        success: false,
        error: 'endpoint is required',
        code: 'INVALID_REQUEST',
      });
    }

    const useAlias = !provider && !modelId && !!model;
    if (!useAlias && (!provider || !modelId)) {
      return res.status(400).json({
        success: false,
        error: 'provider and modelId are required when not using an Alia model alias',
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

    const callBody = formData ? undefined : body;

    const data = useAlias
      ? await callAliaModelAPI({
          model,
          endpoint,
          body: callBody,
          formData,
          maxAttempts: maxAttempts ?? 3,
          timeout: timeout ?? 30000,
          responseType: responseType ?? 'json',
          maxProviderAttempts,
        })
      : await callProviderAPI({
          provider: provider as string,
          modelId: modelId as string,
          endpoint,
          body: callBody,
          formData,
          maxAttempts: maxAttempts ?? 3,
          timeout: timeout ?? 30000,
          responseType: responseType ?? 'json',
        });

    // Binary responses (e.g. TTS audio): return base64-encoded buffer
    const payload = useAlias ? (data as { data?: unknown }).data ?? data : data;
    if (responseType === 'arrayBuffer' && Buffer.isBuffer(payload)) {
      return res.json({
        success: true,
        data: payload.toString('base64'),
        encoding: 'base64',
      });
    }

    res.json({ success: true, data: payload });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Provider API call failed');
    const reason = (typeof error === 'object' && error !== null && 'reason' in error)
      ? String((error as { reason?: unknown }).reason)
      : 'unknown';
    res.status(502).json({
      success: false,
      error: errorMessage(error, 'Provider API call failed'),
      reason,
      code: 'PROVIDER_ERROR',
    });
  }
});

export default router;
