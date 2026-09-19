import { Router, type Request, type Response } from 'express';
import { OxyInferenceError } from '@oxy.so/core';
import { z } from 'zod';
import { findMessageAudioUrl, setMessageAudioUrl } from '../../db/chat/messageRepository.js';
import { synthesizeSpeech } from '../../lib/synthesize-speech.js';
import { deleteS3Objects, uploadToS3 } from '../../lib/s3.js';

import { getDb } from '../../db/index.js';
import { findAudioJobStatus } from '../../db/notifications/audioJobRepository.js';
import {
  kaanaCapabilityUnavailable,
  type KaanaUnavailableCapability,
} from '../../lib/inference/hosted-capability-error.js';
import { log } from '../../lib/logger.js';
import { sanitizeMessage } from '../../lib/errors/index.js';
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

const speechBody = z.object({
  model: z.literal('route:voice').optional(),
  input: z.string().min(1).max(15_000).refine((input) => input.trim().length > 0),
  voice: z.enum(['male', 'female']).default('female'),
  speed: z.number().min(0.7).max(1.5).optional(),
  conversationId: z.string().min(1).max(128).optional(),
  messageId: z.string().min(1).max(128).optional(),
}).strict();

router.post('/speech', async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = speechBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid speech request', retryable: false } });
  const body = parsed.data;
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  let key: string | undefined;
  try {
    if (storedMediaUrl(req, 'speech-readiness', userId) === null) return unavailable(res, 'speech_synthesis');
    if (body.conversationId !== undefined && body.messageId !== undefined) {
      const cached = await findMessageAudioUrl(getDb(), userId, body.conversationId, body.messageId);
      if (cached === undefined) return res.status(404).json({ error: { message: 'Message not found', retryable: false } });
    }
    const speech = await synthesizeSpeech({ input: body.input, voice: body.voice, format: 'mp3', userId,
      ...(body.speed === undefined ? {} : { speed: body.speed }), signal: controller.signal });
    controller.signal.throwIfAborted();
    key = await uploadToS3(speech.audio, 'speech.mp3', `tts/${userId}`, 'speech');
    controller.signal.throwIfAborted();
    const audioUrl = storedMediaUrl(req, key, userId);
    if (audioUrl === null) throw new Error('Speech playback is unavailable');
    if (body.conversationId !== undefined && body.messageId !== undefined) {
      const updated = await setMessageAudioUrl(getDb(), userId, body.conversationId, body.messageId, key);
      if (updated !== 1) throw new Error('Message was removed during speech generation');
    }
    return res.json({ audioUrl, requestId: speech.requestId });
  } catch (error: unknown) {
    if (key !== undefined) await deleteS3Objects([key]).catch(() => {
      log.general.error('Speech object cleanup failed');
    });
    if (controller.signal.aborted) return;
    if (error instanceof OxyInferenceError) {
      if (error.retryAfterMs !== undefined) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      return res.status(error.status).json({ error: { code: error.code, message: sanitizeMessage(error.message), requestId: error.requestId,
        retryable: error.retryable, retryAfterMs: error.retryAfterMs } });
    }
    log.general.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'Speech generation failed');
    return res.status(502).json({ error: { code: 'SPEECH_GENERATION_FAILED', message: 'Speech could not be generated. Please try again.', retryable: false } });
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
      return res.status(404).json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }

    const job = await findAudioJobStatus(getDb(), jobId, userId);
    if (!job) {
      return res.status(404).json({ error: { message: 'Job not found', type: 'invalid_request_error' } });
    }
    if (job.status === 'completed') {
      if (job.audioUrl === null) {
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
    return res.json({ status: 'processing' });
  } catch (error: unknown) {
    log.general.error({ err: error, jobId: req.params.jobId }, 'Job status check failed');
    return res.status(500).json({ error: { message: 'Failed to check job status', type: 'server_error' } });
  }
});

export default router;
