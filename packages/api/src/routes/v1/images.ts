import { Router, type Request, type Response } from 'express';

import { kaanaCapabilityUnavailable } from '../../lib/inference/hosted-capability-error.js';

const router = Router();

router.post('/generations', (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

  const error = kaanaCapabilityUnavailable('image_generation');
  return res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      type: 'server_error',
      retryable: false,
    },
  });
});

export default router;
