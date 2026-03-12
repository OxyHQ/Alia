import { Router } from 'express';
import { getModelMappingsForTier, callProviderAPI } from '../../lib/gateway-client.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { Message } from '../../models/message.js';
import { log } from '../../lib/logger.js';
import { getSafeErrorMessage } from '../../lib/errors/sanitize.js';
import { extractAudioUrl } from '../../internal/providers/lib/digitalocean-async.js';
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
  const TTS_TIMEOUT_MS = 55_000;
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort('TTS global timeout'), TTS_TIMEOUT_MS);

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
      const existingMsg = await Message.findOne(
        { conversationId, oxyUserId: userId, id: messageId },
        { audioUrl: 1 }
      ).lean();
      if (existingMsg?.audioUrl) {
        return res.json({ audioUrl: existingMsg.audioUrl });
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

    // Resolve TTS provider via tier mappings — try each in priority order (fail fast, move to next)
    const ttsMappings = await getModelMappingsForTier('v1-tts');
    const ttsVoice = voice || 'nova';
    let audioBuffer: Buffer | null = null;

    for (const mapping of ttsMappings) {
      if (abortController.signal.aborted) break;
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
          maxAttempts: 1,
          timeout: 15_000,
          signal: abortController.signal,
        });
        break; // success
      } catch (err: unknown) {
        log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'TTS provider failed, trying next');
        continue;
      }
    }

    if (!audioBuffer) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'TTS generation failed — please try again', type: 'server_error' } });
    }

    // Charge credits based on character count (~1 credit per 200 chars)
    const charCredits = Math.max(1, Math.ceil(input.length / 200));

    // Upload to S3 and finalize credits concurrently (with 15s safety timeout)
    let uploadTimer: NodeJS.Timeout;
    const uploadResult = await Promise.race([
      Promise.all([
        uploadToS3(audioBuffer, `audio.${format}`, `tts/${userId}`, 'speech'),
        finalizeCredits(reservation, {
          promptTokens: charCredits * 50,
          completionTokens: 0,
          totalTokens: charCredits * 50,
        }),
      ]).then(result => { clearTimeout(uploadTimer); return result; }),
      new Promise<never>((_, reject) => {
        uploadTimer = setTimeout(() => reject(new Error('S3 upload timeout')), 15_000);
      }),
    ]);

    const audioUrl = uploadResult[0];

    // Link to message (fire-and-forget, don't block response)
    if (conversationId && messageId) {
      Message.updateOne(
        { conversationId, oxyUserId: userId, id: messageId },
        { $set: { audioUrl } }
      ).catch((err: any) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audioUrl to message');
      });
    }

    res.json({ audioUrl });
  } catch (error: unknown) {
    const timedOut = abortController.signal.aborted;
    log.general.error({ err: error, userId: req.user?.id, timedOut }, 'TTS synthesis failed');
    const status = timedOut ? 504 : 500;
    res.status(status).json({ error: { message: getSafeErrorMessage(error, 'Synthesis failed'), type: 'server_error' } });
  } finally {
    clearTimeout(globalTimer);
  }
});

/**
 * POST /v1/audio/generate
 * AI audio/music/sound generation from text prompts.
 * Uses DigitalOcean's fal-ai/stable-audio-25 model via async-invoke.
 *
 * Body: { prompt, seconds_total?, conversationId?, messageId? }
 * Returns: { audioUrl: string }
 */
router.post('/generate', async (req: Request, res: Response) => {
  const GEN_TIMEOUT_MS = 60_000;
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort('Audio gen global timeout'), GEN_TIMEOUT_MS);

  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { prompt, seconds_total, conversationId, messageId } = req.body as {
      prompt?: string;
      seconds_total?: number;
      conversationId?: string;
      messageId?: string;
    };

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Prompt is required', type: 'invalid_request_error' } });
    }

    if (prompt.length > 4096) {
      return res.status(400).json({ error: { message: 'Prompt exceeds 4096 character limit', type: 'invalid_request_error' } });
    }

    const duration = Math.min(seconds_total || 30, 120); // Max 2 minutes

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

    // Call audio generation model (async-invoke via provider-api)
    let audioOutput: any = null;
    try {
      audioOutput = await callProviderAPI<any>({
        provider: 'digitalocean',
        modelId: 'fal-ai/stable-audio-25/text-to-audio',
        endpoint: '/v1/async-invoke', // triggers async-invoke path in provider-api
        body: {
          input: {
            prompt,
            seconds_total: duration,
          },
        },
        timeout: 45_000,
        maxAttempts: 1,
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      log.general.warn({ err }, 'Audio generation failed');
    }

    if (!audioOutput) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'Audio generation failed — please try again', type: 'server_error' } });
    }

    // Extract audio URL from the async-invoke result
    const generatedUrl = extractAudioUrl(audioOutput);
    if (!generatedUrl) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(502).json({ error: { message: 'Audio generation returned no result', type: 'server_error' } });
    }

    // Download and upload to S3
    const audioRes = await fetch(generatedUrl, { signal: abortController.signal });
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Charge credits based on duration (~1 credit per 10 seconds)
    const durationCredits = Math.max(1, Math.ceil(duration / 10));

    let uploadTimer: NodeJS.Timeout;
    const uploadResult = await Promise.race([
      Promise.all([
        uploadToS3(audioBuffer, 'audio.mp3', `audio-gen/${userId}`, 'generated'),
        finalizeCredits(reservation, {
          promptTokens: durationCredits * 50,
          completionTokens: 0,
          totalTokens: durationCredits * 50,
        }),
      ]).then(result => { clearTimeout(uploadTimer); return result; }),
      new Promise<never>((_, reject) => {
        uploadTimer = setTimeout(() => reject(new Error('S3 upload timeout')), 15_000);
      }),
    ]);

    const audioUrl = uploadResult[0];

    // Link to message (fire-and-forget)
    if (conversationId && messageId) {
      Message.updateOne(
        { conversationId, oxyUserId: userId, id: messageId },
        { $set: { audioUrl } }
      ).catch((err: any) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audioUrl to message');
      });
    }

    res.json({ audioUrl });
  } catch (error: unknown) {
    const timedOut = abortController.signal.aborted;
    log.general.error({ err: error, userId: req.user?.id, timedOut }, 'Audio generation failed');
    const status = timedOut ? 504 : 500;
    res.status(status).json({ error: { message: getSafeErrorMessage(error, 'Audio generation failed'), type: 'server_error' } });
  } finally {
    clearTimeout(globalTimer);
  }
});

export default router;
