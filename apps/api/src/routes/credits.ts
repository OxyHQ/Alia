import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { UserCredits } from '../models/user-credits.js';

const router = Router();

// Helper to get or create UserCredits record
async function getOrCreateUserCredits(userId: string) {
  return UserCredits.findByIdAndUpdate(
    userId,
    {
      $setOnInsert: {
        _id: userId,
        credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
      },
    },
    { upsert: true, new: true }
  );
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userCredits = await getOrCreateUserCredits(req.user!.id);
    await userCredits.refreshCreditsIfNeeded();

    res.json({
      credits: userCredits.credits.free + userCredits.credits.paid,
      freeCredits: userCredits.credits.free,
      paidCredits: userCredits.credits.paid,
      dailyRefresh: userCredits.credits.dailyRefresh,
      lastRefresh: userCredits.credits.lastRefresh,
    });
  } catch (error: any) {
    console.error('[Credits] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
