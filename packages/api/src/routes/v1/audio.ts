import { Router, type Request, type Response } from 'express';

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

router.post('/speech', (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  return unavailable(res, 'speech_synthesis');
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
