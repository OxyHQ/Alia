/**
 * POST /api/report
 * Fire-and-forget usage/error reporting from the main API.
 * Used after streaming chat completions to record key health + provider health.
 */

import express, { Request, Response } from 'express';
import { recordKeySuccess, recordKeyFailure, recordKeyUsage, markKeyCreditExhausted } from '../lib/key-manager.js';
import { recordSuccess, recordFailure } from '../lib/provider-health.js';
import { log } from '../lib/logger.js';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  // Respond immediately — processing is fire-and-forget
  res.json({ success: true });

  try {
    const { keyId, provider, modelId, success, latencyMs, errorCode, tokens, reason } = req.body;

    if (!keyId || !provider || !modelId) return;

    if (success) {
      await Promise.all([
        recordKeySuccess(keyId),
        recordKeyUsage(keyId, tokens ?? 0, provider, modelId),
        recordSuccess(provider, modelId, latencyMs ?? 0),
      ]);
    } else {
      const failReason = errorCode || reason || 'unknown';
      await Promise.all([
        recordKeyFailure(keyId, `${modelId}: ${failReason}`),
        recordFailure(provider, modelId, failReason),
      ]);

      if (failReason === 'billing') {
        await markKeyCreditExhausted(keyId);
      }
    }
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error processing usage report');
  }
});

export default router;
