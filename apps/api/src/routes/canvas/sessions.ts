import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { CanvasSession } from '../../models/canvas-session.js';
import type { Request, Response } from 'express';

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
    console.error('Error fetching canvas session:', error);
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
    console.error('Error clearing canvas session:', error);
    res.status(500).json({ error: 'Failed to clear canvas session' });
  }
});

export default router;
