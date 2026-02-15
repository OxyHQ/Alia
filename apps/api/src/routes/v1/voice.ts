import { Router } from 'express';
import { randomUUID } from 'crypto';
import { createVoiceToken, isLiveKitConfigured, getLiveKitUrl } from '../../lib/livekit-token.js';
import { getBestKeyForModel, recordKeySuccess, recordKeyFailure } from '../../internal/providers/lib/key-manager.js';
import { getModelMappingsForTier } from '../../internal/providers/lib/alia-models.js';
import { reserveCredits, finalizeCredits, refundReservation } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { log } from '../../lib/logger.js';
import { getUserEntitlements } from '../../lib/plan-access.js';
import type { Request, Response } from 'express';

const WHISPER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/audio/transcriptions',
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
};

const router = Router();

/**
 * POST /v1/voice/token
 * Get a LiveKit token to join a voice room
 */
router.post('/token', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!isLiveKitConfigured()) {
      return res.status(503).json({ error: 'Voice mode is not available. LiveKit is not configured.' });
    }

    // Enforce voice-mode feature access
    const entitlements = await getUserEntitlements(userId);
    if (!entitlements.features['voice-mode']) {
      return res.status(403).json({
        error: {
          code: 'FEATURE_NOT_IN_PLAN',
          message: 'Upgrade your plan to use voice mode.',
          retryable: false,
          suggestedAction: 'upgrade',
        },
      });
    }

    const { conversationId } = req.body;
    const roomName = `voice-${conversationId || randomUUID()}`;

    const token = await createVoiceToken(userId, roomName);

    res.json({
      token,
      url: getLiveKitUrl(),
      roomName,
    });
  } catch (error: any) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice token generation failed');
    res.status(500).json({ error: error.message || 'Failed to create voice token' });
  }
});

/**
 * POST /v1/voice/transcribe
 * Speech-to-text transcription using OpenAI Whisper or Groq Whisper API
 * Timeout: 30 seconds per request (returns 504 if provider hangs)
 */
router.post('/transcribe', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { audio, format } = req.body as { audio?: string; format?: string };
    if (!audio) {
      return res.status(400).json({ error: 'Audio data is required (base64 encoded)' });
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

    // Resolve a Whisper-compatible provider key using the v1-audio tier
    let apiKey: string | null = null;
    let whisperUrl = '';
    let whisperModel = '';
    let resolvedKeyId: string | null = null;

    const audioMappings = getModelMappingsForTier('v1-audio');

    for (const mapping of audioMappings) {
      const url = WHISPER_URLS[mapping.provider];
      if (!url) continue;

      try {
        const keyConfig = await getBestKeyForModel(mapping.provider, mapping.modelId);
        if (keyConfig?.key) {
          apiKey = keyConfig.key;
          whisperUrl = url;
          whisperModel = mapping.modelId;
          resolvedKeyId = keyConfig.keyId || null;
          break;
        }
      } catch (err) {
        log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'Transcription key lookup failed');
      }
    }

    if (!apiKey) {
      log.general.error('All transcription providers exhausted, no key available');
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(503).json({ error: 'No transcription provider available' });
    }

    // Convert base64 to buffer and call Whisper API with 30s timeout
    const audioBuffer = Buffer.from(audio, 'base64');
    const mimeType = format || 'audio/m4a';
    const ext = mimeType.split('/')[1] || 'm4a';

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', whisperModel);

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 30000);

    let response: globalThis.Response;
    try {
      response = await fetch(whisperUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);
    } catch (fetchError: any) {
      clearTimeout(fetchTimeout);
      if (fetchError.name === 'AbortError') {
        log.general.error({ whisperModel, whisperUrl }, 'Whisper API timeout (30s)');
        if (resolvedKeyId) recordKeyFailure(resolvedKeyId, 'Whisper API timeout').catch(() => {});
        await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return res.status(504).json({ error: 'Transcription timed out' });
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      log.general.error({ whisperModel, statusCode: response.status, errorBody }, 'Whisper API error');
      if (resolvedKeyId) recordKeyFailure(resolvedKeyId, `Whisper API ${response.status}`).catch(() => {});
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(502).json({ error: 'Transcription failed' });
    }

    const result = await response.json() as { text: string };

    if (resolvedKeyId) recordKeySuccess(resolvedKeyId).catch(() => {});

    // Charge minimal credits for transcription (~100 tokens equivalent)
    await finalizeCredits(reservation, {
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
    });

    res.json({ text: result.text });
  } catch (error: any) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice transcription failed');
    res.status(500).json({ error: error.message || 'Transcription failed' });
  }
});

export default router;
