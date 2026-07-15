import { Router } from 'express';
import { callProviderAPI } from '../../lib/gateway-client.js';
import { synthesizeSpeech } from '../../lib/synthesize-speech.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import type { CreditReservation } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { Message } from '../../models/message.js';
import { AudioJob } from '../../models/audio-job.js';
import { log } from '../../lib/logger.js';
import { getSafeErrorMessage } from '../../lib/errors/sanitize.js';
import { extractAudioUrl } from '../../internal/providers/lib/digitalocean-async.js';
import { emitAudioJobUpdate } from '../../socket.js';
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

    const { input, voice, response_format, speed, conversationId, messageId } = req.body as {
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

    // Synthesize speech, failing over across every TTS provider with an available key.
    const synthesized = await synthesizeSpeech({
      input,
      voice: voice || 'nova',
      format,
      speed,
      signal: abortController.signal,
    });

    if (!synthesized) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'TTS generation failed — please try again', type: 'server_error' } });
    }

    const { audio: audioBuffer, format: outputFormat } = synthesized;

    // Charge credits based on character count (~1 credit per 200 chars)
    const charCredits = Math.max(1, Math.ceil(input.length / 200));

    // Upload to S3 and finalize credits concurrently (with 15s safety timeout)
    let uploadTimer: NodeJS.Timeout;
    const uploadResult = await Promise.race([
      Promise.all([
        uploadToS3(audioBuffer, `audio.${outputFormat}`, `tts/${userId}`, 'speech'),
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
 *
 * Returns a job ID immediately. The client polls GET /v1/audio/jobs/:jobId
 * for completion, since fal-ai generation can take 60-90s (exceeding
 * DO App Platform's ~60s proxy timeout).
 *
 * Body: { prompt, seconds_total?, conversationId?, messageId? }
 * Returns: { jobId: string, status: 'processing' }
 */
router.post('/generate', async (req: Request, res: Response) => {
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

    const duration = Math.min(seconds_total || 30, 120);

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

    // Create job record — return immediately so the client isn't blocked
    const job = await AudioJob.create({
      userId,
      status: 'processing',
      prompt,
      duration,
      conversationId,
      messageId,
    });

    // Respond immediately with job ID
    res.status(202).json({ jobId: job._id.toString(), status: 'processing' });

    // Background: generate audio, upload to S3, finalize credits
    void processAudioGeneration({ jobId: job._id.toString(), userId, prompt, duration, reservation, conversationId, messageId });
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Audio generation submission failed');
    res.status(500).json({ error: { message: getSafeErrorMessage(error, 'Audio generation failed'), type: 'server_error' } });
  }
});

interface AudioGenJobInput {
  jobId: string;
  userId: string;
  prompt: string;
  duration: number;
  reservation: CreditReservation;
  conversationId?: string;
  messageId?: string;
}

/**
 * Background audio generation processor.
 * Runs after the HTTP response is sent — not subject to proxy timeouts.
 */
async function processAudioGeneration(input: AudioGenJobInput): Promise<void> {
  const { jobId, userId, prompt, duration, reservation, conversationId, messageId } = input;
  const GEN_TIMEOUT_MS = 180_000; // 3 minutes — generous for queue + cold start + generation
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort('Audio gen timeout'), GEN_TIMEOUT_MS);

  try {
    // Call audio generation model
    let audioOutput: any = null;
    try {
      audioOutput = await callProviderAPI<any>({
        provider: 'digitalocean',
        modelId: 'fal-ai/stable-audio-25/text-to-audio',
        endpoint: '/v1/async-invoke',
        body: {
          input: {
            prompt,
            seconds_total: duration,
          },
        },
        timeout: 170_000,
        maxAttempts: 1,
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      log.general.warn({ err, jobId }, 'Audio generation provider call failed');
    }

    if (!audioOutput) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const error = 'Generation failed — all providers exhausted';
      await AudioJob.updateOne({ _id: jobId }, { status: 'failed', error });
      emitAudioJobUpdate(userId, { jobId, status: 'failed', error });
      return;
    }

    // Extract audio URL from the async-invoke result
    const generatedUrl = extractAudioUrl(audioOutput);
    if (!generatedUrl) {
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const error = 'Generation returned no audio';
      await AudioJob.updateOne({ _id: jobId }, { status: 'failed', error });
      emitAudioJobUpdate(userId, { jobId, status: 'failed', error });
      return;
    }

    // Download and upload to S3
    const audioRes = await fetch(generatedUrl, { signal: abortController.signal });
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Charge credits based on duration (~1 credit per 10 seconds)
    const durationCredits = Math.max(1, Math.ceil(duration / 10));

    const [audioUrl] = await Promise.all([
      uploadToS3(audioBuffer, 'audio.mp3', `audio-gen/${userId}`, 'generated'),
      finalizeCredits(reservation, {
        promptTokens: durationCredits * 50,
        completionTokens: 0,
        totalTokens: durationCredits * 50,
      }),
    ]);

    // Update job with result and notify client
    await AudioJob.updateOne({ _id: jobId }, { status: 'completed', audioUrl });
    emitAudioJobUpdate(userId, { jobId, status: 'completed', audioUrl });

    // Link to message (fire-and-forget)
    if (conversationId && messageId) {
      Message.updateOne(
        { conversationId, oxyUserId: userId, id: messageId },
        { $set: { audioUrl } }
      ).catch((err: any) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audioUrl to message');
      });
    }

    log.general.info({ jobId, userId }, 'Audio generation completed');
  } catch (error: unknown) {
    const errMsg = getSafeErrorMessage(error, 'Generation failed');
    log.general.error({ err: error, jobId, userId }, 'Audio generation background processing failed');
    await AudioJob.updateOne(
      { _id: jobId },
      { status: 'failed', error: errMsg }
    ).catch(() => {});
    emitAudioJobUpdate(userId, { jobId, status: 'failed', error: errMsg });
    await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }).catch(() => {});
  } finally {
    clearTimeout(globalTimer);
  }
}

/**
 * GET /v1/audio/jobs/:jobId
 * Poll for audio generation job status.
 *
 * Returns:
 *   { status: 'processing' }                     — still working
 *   { status: 'completed', audioUrl: string }     — done
 *   { status: 'failed', error: string }           — failed
 */
router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { jobId } = req.params;

    const job = await AudioJob.findOne({ _id: jobId, userId }, { status: 1, audioUrl: 1, error: 1 }).lean();
    if (!job) {
      return res.status(404).json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }

    if (job.status === 'completed') {
      return res.json({ status: 'completed', audioUrl: job.audioUrl });
    }

    if (job.status === 'failed') {
      return res.json({ status: 'failed', error: job.error || 'Generation failed' });
    }

    res.json({ status: 'processing' });
  } catch (error: unknown) {
    log.general.error({ err: error, jobId: req.params.jobId }, 'Job status check failed');
    res.status(500).json({ error: { message: 'Failed to check job status', type: 'server_error' } });
  }
});

export default router;
