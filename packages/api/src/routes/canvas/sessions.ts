import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { getDb } from '../../db/index.js';
import {
  deleteCanvasSession,
  findCanvasComponents,
} from '../../db/chat/canvasSessionRepository.js';
import type { Request, Response } from 'express';
import { log } from '../../lib/logger.js';

const router = Router();

router.use(authenticateToken);

/**
 * `req.userId` is typed optional and both handlers refuse a request without it.
 *
 * `authenticateToken` above sets it on every request that gets this far, so the
 * guard never fires — but it is not defensive noise. The Mongoose version passed
 * the value straight into the filter, and Mongo DROPS an `undefined` key: the
 * query would have degraded to "any account's canvas for this conversation id",
 * which is a cross-account read rather than an error. The repository takes a
 * `string`, so that shape is now unrepresentable and this is where it is refused.
 */

// Get canvas session components for a conversation
router.get('/:conversationId', async (req: Request, res: Response) => {
  try {
    const oxyUserId = req.userId;
    if (!oxyUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const components = await findCanvasComponents(
      getDb(),
      oxyUserId,
      String(req.params.conversationId),
    );

    res.json({ components: components ?? [] });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error fetching canvas session');
    res.status(500).json({ error: 'Failed to fetch canvas session' });
  }
});

// Clear canvas session
router.delete('/:conversationId', async (req: Request, res: Response) => {
  try {
    const oxyUserId = req.userId;
    if (!oxyUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await deleteCanvasSession(getDb(), oxyUserId, String(req.params.conversationId));

    res.json({ success: true });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error clearing canvas session');
    res.status(500).json({ error: 'Failed to clear canvas session' });
  }
});

export default router;
