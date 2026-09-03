import { Router, type Request, type Response } from 'express';

import {
  kaanaCapabilityUnavailable,
  type KaanaUnavailableCapability,
} from '../../lib/inference/hosted-capability-error.js';

const router = Router();

function unavailable(res: Response, capability: KaanaUnavailableCapability): Response {
  const error = kaanaCapabilityUnavailable(capability);
  return res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
    },
  });
}

router.post('/token', (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  return unavailable(res, 'voice_session');
});

router.post('/transcribe', (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  return unavailable(res, 'speech_transcription');
});

export default router;
