import { Router } from 'express';
import { getModelMappingsForTier, callProviderAPI } from '../../lib/providers-client.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { Conversation } from '../../models/conversation.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * POST /v1/audio/speech
 * OpenAI-compatible text-to-speech endpoint with S3 caching.
 *
 * Body: { model, input, voice, response_format?, speed?, conversationId?, messageId? }
 * Returns: { audioUrl: string }
 *
 * When conversationId + messageId are provided, the generated audio is cached
 * in S3 and linked to the message. Subsequent requests for the same message
 * return the cached URL without regenerating.
 */
router.post('/speech', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { model, input, voice, response_format, speed, conversationId, messageId } = req.body as {
      model?: string;
      input?: string;
      voice?: string;
      response_format?: string;
      speed?: number;
      conversationId?: string;
      messageId?: string;
    };

    // Check for cached audio on the message
    if (conversationId && messageId) {
      const conversation = await Conversation.findOne(
        { conversationId, oxyUserId: userId, 'messages.id': messageId },
        { 'messages.$': 1 }
      );
      const existingUrl = conversation?.messages?.[0]?.audioUrl;
      if (existingUrl) {
        return res.json({ audioUrl: existingUrl });
      }
    }

    if (!input || input.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Input text is required', type: 'invalid_request_error' } });
    }

    if (input.length > 4096) {
      return res.status(400).json({ error: { message: 'Input text exceeds 4096 character limit', type: 'invalid_request_error' } });
    }

    const format = response_format || 'mp3';
    const validFormats = ['mp3', 'opus', 'aac', 'flac'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({ error: { message: `Unsupported response_format: ${format}`, type: 'invalid_request_error' } });
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

    // Resolve TTS provider via tier mappings
    const ttsMappings = await getModelMappingsForTier('v1-tts');
    const ttsVoice = voice || 'nova';
    let audioBuffer: Buffer | null = null;

    for (const mapping of ttsMappings) {
      try {
        audioBuffer = await callProviderAPI<Buffer>({
          provider: mapping.provider,
          modelId: mapping.modelId,
          endpoint: '/v1/audio/speech',
          body: {
            model: mapping.modelId,
            input,
            voice: ttsVoice,
            response_format: format,
            speed: speed || 1.0,
          },
          responseType: 'arrayBuffer',
          timeout: 30_000,
        });
        break;
      } catch (err: any) {
        log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'TTS provider failed, trying next');
        continue;
      }
    }

    if (!audioBuffer) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(503).json({ error: { message: 'All TTS providers exhausted', type: 'server_error' } });
    }

    // Charge credits based on character count (~1 credit per 200 chars)
    const charCredits = Math.max(1, Math.ceil(input.length / 200));
    await finalizeCredits(reservation, {
      promptTokens: charCredits * 50,
      completionTokens: 0,
      totalTokens: charCredits * 50,
    });

    // Upload to S3
    const audioUrl = await uploadToS3(
      audioBuffer,
      `audio.${format}`,
      `tts/${userId}`,
      'speech'
    );

    // Link to message if conversationId + messageId provided
    if (conversationId && messageId) {
      await Conversation.updateOne(
        { conversationId, oxyUserId: userId, 'messages.id': messageId },
        { $set: { 'messages.$.audioUrl': audioUrl } }
      ).catch((err: any) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audioUrl to message');
      });
    }

    res.json({ audioUrl });
  } catch (error: any) {
    log.general.error({ err: error, userId: req.user?.id }, 'TTS synthesis failed');
    res.status(500).json({ error: { message: error.message || 'Synthesis failed', type: 'server_error' } });
  }
});

export default router;
