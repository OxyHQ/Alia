import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { User } from '../models/user.js';

const router = Router();

// Get user's current credits
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user!.id);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Refresh credits if needed before returning
    await user.refreshCreditsIfNeeded();

    const totalCredits = user.credits.free + (user.credits.paid || 0);

    res.json({
      credits: totalCredits,
      freeCredits: user.credits.freeLimit,
      paidCredits: user.credits.paid || 0,
      dailyRefresh: user.credits.dailyRefresh,
      lastRefresh: user.credits.lastRefresh,
    });
  } catch (error: any) {
    console.error('[Credits] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
