import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { findMessageAudioUrl, setMessageAudioUrl } from '../../db/chat/messageRepository.js';
import { SpeechSynthesisError, synthesizeSpeech } from '../../lib/synthesize-speech.js';
import { deleteS3Objects, uploadToS3 } from '../../lib/s3.js';

import { getDb } from '../../db/index.js';
import { findAudioJobStatus } from '../../db/notifications/audioJobRepository.js';
import {
  kaanaCapabilityUnavailable,
  type KaanaUnavailableCapability,
} from '../../lib/inference/hosted-capability-error.js';
import { log } from '../../lib/logger.js';
import { storedMediaUrl } from '../../lib/stored-media.js';

const router = Router();

function unavailable(res: Response, capability: KaanaUnavailableCapability): Response {
  const error = kaanaCapabilityUnavailable(capability);
  return res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      type: 'server_error',
      retryable: false,
    },
  });
}

/**
 * One structured record per failed speech request: what failed and where, the
 * model(s) tried and Oxy's request id — never the text, the user or a
 * credential.
 */
function logSpeechFailure(
  error: SpeechSynthesisError,
  request: { voice: string; inputChars: number },
): void {
  const record = {
    code: error.code,
    reason: error.reason,
    status: error.httpStatus,
    retryable: error.retryable,
    upstreamCode: error.upstreamCode,
    upstreamStatus: error.upstreamStatus,
    requestId: error.requestId,
    param: error.param,
    models: error.models,
    voice: request.voice,
    inputChars: request.inputChars,
  };
  if (error.code === 'SPEECH_REJECTED' || error.code === 'SPEECH_LIMIT_REACHED')
    log.speech.warn(record, 'Speech synthesis failed');
  else log.speech.error(record, 'Speech synthesis failed');
}

function speechFailure(res: Response, error: SpeechSynthesisError): Response {
  if (error.retryAfterMs !== undefined)
    res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  return res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    },
  });
}

const speechBody = z
  .object({
    /**
     * Ignored: the speech model is chosen from the catalogue (ADR 0012). Still
     * accepted so an older client that names one is not refused.
     */
    model: z.string().max(200).optional(),
    input: z
      .string()
      .min(1)
      .max(15_000)
      .refine((input) => input.trim().length > 0),
    voice: z.enum(['male', 'female']).default('female'),
    speed: z.number().min(0.7).max(1.5).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    messageId: z.string().min(1).max(128).optional(),
  })
  .strict();

router.post('/speech', async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = speechBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Invalid speech request', retryable: false },
    });
  const body = parsed.data;
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abort);
  const request = { voice: body.voice, inputChars: body.input.length };
  let key: string | undefined;
  let stage: 'synthesis' | 'storage' | 'attachment' = 'synthesis';
  try {
    if (storedMediaUrl(req, 'speech-readiness', userId) === null)
      throw new SpeechSynthesisError('SPEECH_UNAVAILABLE', { reason: 'storage_unavailable' });
    if (body.conversationId !== undefined && body.messageId !== undefined) {
      const cached = await findMessageAudioUrl(
        getDb(),
        userId,
        body.conversationId,
        body.messageId,
      );
      if (cached === undefined)
        return res.status(404).json({ error: { message: 'Message not found', retryable: false } });
    }
    // Standalone speech historically admits every authenticated user without
    // an Alia credit operation. Bundle presence must not change that policy.
    // Voice-call chat turns and show episodes retain their own existing metering.
    const speech = await synthesizeSpeech({
      input: body.input,
      voice: body.voice,
      format: 'mp3',
      userId,
      ...(body.speed === undefined ? {} : { speed: body.speed }),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    stage = 'storage';
    key = await uploadToS3(speech.audio, 'speech.mp3', `tts/${userId}`, 'speech');
    controller.signal.throwIfAborted();
    const audioUrl = storedMediaUrl(req, key, userId);
    if (audioUrl === null) throw new Error('Speech playback is unavailable');
    if (body.conversationId !== undefined && body.messageId !== undefined) {
      stage = 'attachment';
      const updated = await setMessageAudioUrl(
        getDb(),
        userId,
        body.conversationId,
        body.messageId,
        key,
      );
      if (updated !== 1) throw new Error('Message was removed during speech generation');
    }
    return res.json({ audioUrl, requestId: speech.requestId });
  } catch (error: unknown) {
    if (key !== undefined)
      await deleteS3Objects([key]).catch(() => {
        log.speech.error('Speech object cleanup failed');
      });
    if (controller.signal.aborted) return;
    if (error instanceof SpeechSynthesisError) {
      logSpeechFailure(error, request);
      return speechFailure(res, error);
    }
    log.speech.error(
      {
        code: 'SPEECH_GENERATION_FAILED',
        stage,
        errorName: error instanceof Error ? error.name : 'unknown',
        voice: request.voice,
        inputChars: request.inputChars,
      },
      'Speech generation failed',
    );
    return res.status(502).json({
      error: {
        code: 'SPEECH_GENERATION_FAILED',
        message: 'Speech could not be generated. Please try again.',
        retryable: false,
      },
    });
  } finally {
    res.off('close', abort);
  }
});

router.post('/generate', (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  return unavailable(res, 'audio_generation');
});

router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { jobId } = req.params;
    if (typeof jobId !== 'string') {
      return res
        .status(404)
        .json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }

    const job = await findAudioJobStatus(getDb(), jobId, userId);
    if (!job) {
      return res
        .status(404)
        .json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }
    if (job.status === 'completed') {
      if (job.audioUrl === null) {
        return res
          .status(500)
          .json({ error: { message: 'The job completed without audio', type: 'server_error' } });
      }
      const link = storedMediaUrl(req, job.audioUrl, userId);
      if (link === null) {
        return res.status(500).json({
          error: { message: 'Audio cannot be served by this deployment', type: 'server_error' },
        });
      }
      return res.json({ status: 'completed', audioUrl: link });
    }
    if (job.status === 'failed') {
      return res.json({ status: 'failed', error: job.error || 'Generation failed' });
    }
    return res.json({ status: 'processing' });
  } catch (error: unknown) {
    log.general.error({ err: error, jobId: req.params.jobId }, 'Job status check failed');
    return res
      .status(500)
      .json({ error: { message: 'Failed to check job status', type: 'server_error' } });
  }
});

export default router;
