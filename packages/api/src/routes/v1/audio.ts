import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { MAX_TRANSCRIPTION_FILE_BYTES } from '@kaana.ai/contracts';
import { getKaanaClient } from '../../lib/kaana/transport.js';
import {
  dictationMediaType,
  TranscriptionError,
  transcribeDictation,
} from '../../lib/voice/transcribe.js';
import { clientMessageExists } from '../../db/chat/messageRepository.js';
import { obtainSpeechClip, purgeConversationSpeechClips } from '../../lib/speech-clips.js';
import { SpeechSynthesisError } from '../../lib/synthesize-speech.js';

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

/**
 * A clip for this text, in this voice and speed: stored if this person already
 * had it made, synthesized (and paid for) only if not — `lib/speech-clips.ts`.
 *
 * `conversationId` + `messageId` name the saved message being read aloud. The
 * message must be this person's (404 otherwise, before anything is made), and
 * the clip then belongs to that conversation, so deleting it takes the clip.
 * Checked again once the clip is in hand: a conversation deleted while its clip
 * was being made would otherwise leave that clip behind.
 */
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
  const message =
    body.conversationId !== undefined && body.messageId !== undefined
      ? { conversationId: body.conversationId, messageId: body.messageId }
      : null;
  const messageGone = async () =>
    message !== null &&
    !(await clientMessageExists(getDb(), userId, message.conversationId, message.messageId));
  let stage: 'clip' | 'attachment' = 'clip';
  try {
    if (storedMediaUrl(req, 'speech-readiness', userId) === null)
      throw new SpeechSynthesisError('SPEECH_UNAVAILABLE', { reason: 'storage_unavailable' });
    if (await messageGone())
      return res.status(404).json({ error: { message: 'Message not found', retryable: false } });
    // Standalone speech historically admits every authenticated user without
    // an Alia credit operation. Bundle presence must not change that policy.
    // Voice-call chat turns and show episodes retain their own existing metering.
    const clip = await obtainSpeechClip(getDb(), {
      userId,
      input: body.input,
      voice: body.voice,
      ...(body.speed === undefined ? {} : { speed: body.speed }),
      conversationId: message?.conversationId ?? null,
      signal: controller.signal,
    });
    log.speech.info(
      {
        cache: clip.cache,
        inflight: clip.inflight,
        model: clip.model,
        voice: request.voice,
        inputChars: request.inputChars,
      },
      'Speech clip served',
    );
    if (message !== null) {
      stage = 'attachment';
      if (await messageGone()) {
        await purgeConversationSpeechClips(getDb(), userId, message.conversationId);
        throw new Error('Message was removed during speech generation');
      }
    }
    const audioUrl = storedMediaUrl(req, clip.locator, userId);
    if (audioUrl === null) throw new Error('Speech playback is unavailable');
    return res.json({
      audioUrl,
      ...(clip.requestId === undefined ? {} : { requestId: clip.requestId }),
    });
  } catch (error: unknown) {
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

/** The clip is held in memory only, for the one request; never written to disk or stored. */
const dictationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIPTION_FILE_BYTES, files: 1, fields: 4 },
});

function transcriptionFailure(res: Response, error: TranscriptionError): Response {
  if (error.retryAfterMs !== undefined)
    res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  return res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    },
  });
}

const dictationFields = z
  .object({
    /** BCP 47: the app's language. Omitted lets the model detect it. */
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .max(35)
      .optional(),
    /** The recorder's own measurement of the clip. */
    durationMs: z.coerce.number().int().nonnegative(),
  })
  .strict();

/**
 * Dictation (ADR 0017 §7): the composer's microphone uploads one clip
 * (multipart `file`, `language`, `durationMs`) and gets its text back.
 *
 * Free on every plan: no plan feature and no credits. A person's own session
 * only — an app-only machine credential is refused, since what is free here is
 * the person's dictation, not transcription as a service.
 */
router.post('/transcriptions', (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId)
    return res.status(401).json({
      error: { code: 'NOT_AUTHENTICATED', message: 'Authentication required', retryable: false },
    });
  if (req.machineCredential)
    return res.status(403).json({
      error: {
        code: 'CREDENTIAL_NOT_SUPPORTED',
        message: 'Dictation takes a person’s session.',
        retryable: false,
      },
    });
  dictationUpload.single('file')(req, res, (uploadError: unknown) => {
    void (async () => {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE')
        return transcriptionFailure(res, new TranscriptionError('CLIP_TOO_LONG'));
      const fields = dictationFields.safeParse(req.body ?? {});
      const mediaType = dictationMediaType(req.file?.mimetype);
      if (uploadError || !req.file || !fields.success || mediaType === null)
        return transcriptionFailure(res, new TranscriptionError('INVALID_REQUEST'));
      try {
        const result = await transcribeDictation(getKaanaClient(), userId, {
          audio: new Uint8Array(req.file.buffer),
          mediaType,
          durationMs: fields.data.durationMs,
          ...(fields.data.language === undefined ? {} : { language: fields.data.language }),
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof TranscriptionError) return transcriptionFailure(res, error);
        log.voice.error({ err: error }, 'Dictation failed');
        return transcriptionFailure(
          res,
          new TranscriptionError('TRANSCRIPTION_FAILED', { retryable: true }),
        );
      }
    })();
  });
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
