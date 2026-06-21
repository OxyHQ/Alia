import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { CanvasSession } from '../../models/canvas-session.js';
import type { Request, Response } from 'express';
import { log } from '../../lib/logger.js';

const router = Router();

router.use(authenticateToken);

// Get canvas session components for a conversation
router.get('/:conversationId', async (req: Request, res: Response) => {
  try {
    const session = await CanvasSession.findOne({
      oxyUserId: req.userId,
      conversationId: req.params.conversationId,
    });

    if (!session) {
      res.json({ components: [] });
      return;
    }

    res.json({ components: session.components });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error fetching canvas session');
    res.status(500).json({ error: 'Failed to fetch canvas session' });
  }
});

// Clear canvas session
router.delete('/:conversationId', async (req: Request, res: Response) => {
  try {
    await CanvasSession.findOneAndDelete({
      oxyUserId: req.userId,
      conversationId: req.params.conversationId,
    });

    res.json({ success: true });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error clearing canvas session');
    res.status(500).json({ error: 'Failed to clear canvas session' });
  }
});

export default router;
