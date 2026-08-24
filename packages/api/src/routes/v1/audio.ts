import { Router } from 'express';
import { callProviderAPI } from '../../lib/gateway-client.js';
import { synthesizeSpeech } from '../../lib/synthesize-speech.js';
import { reserveCredits, finalizeCredits, refundReservation, CREDITS_CONFIG } from '../../lib/credits-manager.js';
import type { CreditReservation } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { storedMediaUrl } from '../../lib/stored-media.js';
import { findMessageAudioUrl, setMessageAudioUrl } from '../../db/chat/messageRepository.js';
import { getDb } from '../../db/index.js';
import {
  createAudioJob,
  findAudioJobStatus,
  markAudioJobCompleted,
  markAudioJobFailed,
} from '../../db/notifications/audioJobRepository.js';
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

  /**
   * Declared OUT here, and not where it is taken, because the `catch` below has
   * to be able to give it back.
   *
   * A reservation DEBITS immediately, so an exit that neither charges nor
   * refunds does not "do nothing" — it keeps the credit. While this lived inside
   * the `try` the catch could not name it, and every throw after the reservation
   * silently cost the caller a credit for work that never happened.
   */
  let reservation: CreditReservation | null = null;
  let settled = false;

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
      const cached = await findMessageAudioUrl(getDb(), userId, conversationId, messageId);
      if (cached) {
        // Rendered on the way out, exactly like a fresh one. The row holds a
        // KEY, which is not an address — a cache hit that returned it verbatim
        // would hand the player a string it cannot fetch.
        const link = storedMediaUrl(req, cached, userId);
        if (link !== null) return res.json({ audioUrl: link });
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
    reservation = await reserveCredits(userId);
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
      // REFUND, not a zero-token finalize. `calculateCreditsFromTokens` returns
      // MIN_CREDITS_PER_REQUEST for zero tokens, so finalizing here BILLED the
      // caller the minimum for a request that produced nothing — and when no
      // provider in the chain holds a key, never reached a provider at all.
      settled = true;
      await refundReservation(reservation);
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'TTS generation failed — please try again', type: 'server_error' } });
    }

    const { audio: audioBuffer, format: outputFormat } = synthesized;

    // Charge credits based on character count (~1 credit per 200 chars)
    const charCredits = Math.max(1, Math.ceil(input.length / 200));

    /**
     * The same charge, restated in the unit `finalizeCredits` settles in.
     *
     * It settles TOKENS, not credits: `calculateCreditsFromTokens` divides by
     * `TOKENS_PER_CREDIT` and applies the alias model's multiplier. So a figure
     * already denominated in CREDITS survives the round trip only if it is
     * multiplied by `TOKENS_PER_CREDIT` on the way in. No alias model is passed
     * here, so the multiplier is 1 and the conversion is exact.
     *
     * It was `charCredits * 50` — a twentieth of a credit apiece against a
     * thousand-token credit. A 4,000 character request meant to cost 20 credits
     * settled at `ceil(1000 / 1000)` = 1, and anything shorter settled at
     * `MIN_CREDITS_PER_REQUEST`, also 1. Only an input short enough to hit that
     * floor was ever charged the right amount, which is why the endpoint looked
     * correct in every hand test: 200 characters is 1 credit either way.
     */
    const billedTokens = charCredits * CREDITS_CONFIG.TOKENS_PER_CREDIT;

    // Upload to S3 and finalize credits concurrently (with 15s safety timeout)
    let uploadTimer: NodeJS.Timeout;
    // Before the race, not after: `finalizeCredits` is issued INSIDE it, so the
    // 15s upload timeout can win with the charge already in flight. Marking it
    // settled here is what stops the catch refunding a reservation that paid.
    settled = true;
    const uploadResult = await Promise.race([
      Promise.all([
        uploadToS3(audioBuffer, `audio.${outputFormat}`, `tts/${userId}`, 'speech'),
        finalizeCredits(reservation, {
          promptTokens: billedTokens,
          completionTokens: 0,
          totalTokens: billedTokens,
        }),
      ]).then(result => { clearTimeout(uploadTimer); return result; }),
      new Promise<never>((_, reject) => {
        uploadTimer = setTimeout(() => reject(new Error('S3 upload timeout')), 15_000);
      }),
    ]);

    const audioKey = uploadResult[0];

    // Link to message (fire-and-forget, don't block response)
    if (conversationId && messageId) {
      setMessageAudioUrl(getDb(), userId, conversationId, messageId, audioKey).catch((err: unknown) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audioUrl to message');
      });
    }

    const link = storedMediaUrl(req, audioKey, userId);
    if (link === null) {
      // No signing secret, so no address can be produced for a stored object.
      // Failing here is the honest answer: the clip exists and cannot be handed
      // over, which is a deployment fault rather than a synthesis one.
      return res.status(500).json({ error: { message: 'Audio cannot be served by this deployment', type: 'server_error' } });
    }
    res.json({ audioUrl: link });
  } catch (error: unknown) {
    if (reservation && !settled) {
      // No `settled = true` here: nothing reads it after a catch, and eslint
      // `no-useless-assignment` is right to call that out. The GUARD is what
      // matters — it is why a charged reservation is not also refunded.
      await refundReservation(reservation).catch((err: unknown) =>
        log.general.error({ err, userId: req.user?.id }, 'refundReservation failed after TTS error'));
    }
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

  /**
   * Declared OUT here, and not where it is taken, because the `catch` below has
   * to be able to give it back.
   *
   * A reservation DEBITS immediately, so an exit that neither charges nor
   * refunds does not "do nothing" — it keeps the credit. While this lived inside
   * the `try` the catch could not name it, and every throw after the reservation
   * silently cost the caller a credit for work that never happened.
   */
  let reservation: CreditReservation | null = null;
  let settled = false;
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
    reservation = await reserveCredits(userId);
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
    const jobId = await createAudioJob(getDb(), {
      userId,
      prompt,
      durationSeconds: duration,
      conversationId,
      messageId,
    });

    // Respond immediately with job ID
    res.status(202).json({ jobId, status: 'processing' });

    // Background: generate audio, upload to S3, finalize credits
    // Ownership of the reservation passes to the background job, which settles
    // it on every one of its own exits. The catch below must not also refund it.
    settled = true;
    void processAudioGeneration({ jobId, userId, prompt, duration, reservation, conversationId, messageId });
  } catch (error: unknown) {
    if (reservation && !settled) {
      // No `settled = true` here: nothing reads it after a catch, and eslint
      // `no-useless-assignment` is right to call that out. The GUARD is what
      // matters — it is why a charged reservation is not also refunded.
      await refundReservation(reservation).catch((err: unknown) =>
        log.general.error({ err, userId: req.user?.id }, 'refundReservation failed after submission error'));
    }
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
      // REFUND, not a zero-token finalize. `calculateCreditsFromTokens` returns
      // MIN_CREDITS_PER_REQUEST for zero tokens, so finalizing here BILLED the
      // caller the minimum for a request that produced nothing — and when no
      // provider in the chain holds a key, never reached a provider at all.
      await refundReservation(reservation);
      const error = 'Generation failed — all providers exhausted';
      await markAudioJobFailed(getDb(), jobId, error);
      emitAudioJobUpdate(userId, { jobId, status: 'failed', error });
      return;
    }

    // Extract audio URL from the async-invoke result
    const generatedUrl = extractAudioUrl(audioOutput);
    if (!generatedUrl) {
      await refundReservation(reservation);
      const error = 'Generation returned no audio';
      await markAudioJobFailed(getDb(), jobId, error);
      emitAudioJobUpdate(userId, { jobId, status: 'failed', error });
      return;
    }

    // Download and upload to S3
    const audioRes = await fetch(generatedUrl, { signal: abortController.signal });
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Charge credits based on duration (~1 credit per 10 seconds)
    const durationCredits = Math.max(1, Math.ceil(duration / 10));

    /**
     * The same charge, restated in the unit `finalizeCredits` settles in.
     *
     * It settles TOKENS, not credits: `calculateCreditsFromTokens` divides by
     * `TOKENS_PER_CREDIT` and applies the alias model's multiplier. So a figure
     * already denominated in CREDITS survives the round trip only if it is
     * multiplied by `TOKENS_PER_CREDIT` on the way in.
     *
     * It was `durationCredits * 50`, and this endpoint is the one where that
     * did the most damage. `duration` is capped at 120 seconds a few lines
     * above, so `durationCredits` never exceeds 12 and the old expression never
     * exceeded 600 tokens — which never reaches the 1000 tokens that make one
     * credit. Every audio generation this endpoint has ever produced was
     * charged exactly `MIN_CREDITS_PER_REQUEST`, at every length: not an
     * undercharge that grew with the request, a flat rate of one credit
     * arrived at by accident.
     */
    const billedTokens = durationCredits * CREDITS_CONFIG.TOKENS_PER_CREDIT;

    const [audioKey] = await Promise.all([
      uploadToS3(audioBuffer, 'audio.mp3', `audio-gen/${userId}`, 'generated'),
      finalizeCredits(reservation, {
        promptTokens: billedTokens,
        completionTokens: 0,
        totalTokens: billedTokens,
      }),
    ]);

    await markAudioJobCompleted(getDb(), jobId, audioKey);
    /**
     * The socket says it is done; it does not say where.
     *
     * An address is only producible where a REQUEST exists — the scheme and
     * host come from one — and a socket frame has none. Emitting a key under
     * the name `audioUrl` would be handing the client a string it cannot
     * fetch, which is the mistake this whole change removes.
     *
     * The client already handles this: its socket handler settles only when an
     * `audioUrl` is present, and its polling fallback asks
     * `GET /v1/audio/jobs/:jobId`, which renders one. The cost is at most one
     * poll interval.
     */
    emitAudioJobUpdate(userId, { jobId, status: 'completed' });

    // Link to message (fire-and-forget)
    if (conversationId && messageId) {
      setMessageAudioUrl(getDb(), userId, conversationId, messageId, audioKey).catch((err: unknown) => {
        log.general.warn({ err, conversationId, messageId }, 'Failed to link audio to message');
      });
    }

    log.general.info({ jobId, userId }, 'Audio generation completed');
  } catch (error: unknown) {
    const errMsg = getSafeErrorMessage(error, 'Generation failed');
    log.general.error({ err: error, jobId, userId }, 'Audio generation background processing failed');
    await markAudioJobFailed(getDb(), jobId, errMsg).catch(() => {});
    emitAudioJobUpdate(userId, { jobId, status: 'failed', error: errMsg });
    await refundReservation(reservation).catch(() => {});
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

    // Express types a route parameter as `string | string[]`. Under Mongo the
    // array went straight into the filter as `{ _id: [...] }` and matched
    // nothing; the repository asks for the id it will compare, so the shape is
    // checked here and answered with the same 404 a miss gets.
    const { jobId } = req.params;
    if (typeof jobId !== 'string') {
      return res.status(404).json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }

    const job = await findAudioJobStatus(getDb(), jobId, userId);
    if (!job) {
      return res.status(404).json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }

    if (job.status === 'completed') {
      if (job.audioUrl === null) {
        // Completed with nothing stored is a contradiction, and reporting it as
        // completed would leave the client waiting for an address that will
        // never come.
        return res.status(500).json({ error: { message: 'The job completed without audio', type: 'server_error' } });
      }
      const link = storedMediaUrl(req, job.audioUrl, userId);
      if (link === null) {
        return res.status(500).json({ error: { message: 'Audio cannot be served by this deployment', type: 'server_error' } });
      }
      return res.json({ status: 'completed', audioUrl: link });
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
