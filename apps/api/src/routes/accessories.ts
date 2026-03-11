import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { Accessory } from '../models/accessory.js';
import { UserAccessories } from '../models/user-accessories.js';
import { UserCredits } from '../models/user-credits.js';
import { log } from '../lib/logger.js';

const router = Router();

// GET / - List all published accessories (public)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const accessories = await Accessory.find({ isPublished: true })
      .sort({ slot: 1, rarity: 1, name: 1 })
      .lean();
    res.json({ accessories });
  } catch (error) {
    log.general.error({ err: error }, 'Error listing accessories');
    res.status(500).json({ error: 'Failed to list accessories' });
  }
});

// GET /me - Get user's owned accessory IDs
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userAcc = await UserAccessories.findById(req.user.id).lean();
    // Client already knows which accessories are isDefault from the catalog.
    // Return only the user's explicitly purchased accessories.
    res.json({ owned: userAcc?.ownedAccessories ?? [] });
  } catch (error) {
    log.general.error({ err: error }, 'Error getting user accessories');
    res.status(500).json({ error: 'Failed to get owned accessories' });
  }
});

// POST /:id/purchase - Purchase an accessory with credits
router.post('/:id/purchase', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const accessory = await Accessory.findById(req.params.id);
    if (!accessory || !accessory.isPublished) {
      return res.status(404).json({ error: 'Accessory not found' });
    }

    if (accessory.isDefault) {
      return res.status(400).json({ error: 'This accessory is already free for all users' });
    }

    // Atomically claim ownership — fails if already owned (no double-charge)
    const claimed = await UserAccessories.findOneAndUpdate(
      { _id: req.user.id, ownedAccessories: { $ne: accessory._id } },
      { $addToSet: { ownedAccessories: accessory._id } },
      { upsert: true, returnDocument: 'after' }
    );

    if (!claimed || !claimed.ownedAccessories.includes(accessory._id)) {
      return res.status(400).json({ error: 'You already own this accessory' });
    }

    // Deduct credits after atomic claim
    if (accessory.price > 0) {
      const userCredits = await UserCredits.findById(req.user.id);
      if (!userCredits) {
        // Roll back ownership
        await UserAccessories.findByIdAndUpdate(req.user.id, {
          $pull: { ownedAccessories: accessory._id },
        });
        return res.status(402).json({ error: 'No credit balance found', creditsNeeded: accessory.price });
      }
      await userCredits.refreshCreditsIfNeeded();
      const success = await userCredits.deductCredits(accessory.price);
      if (!success) {
        // Roll back ownership
        await UserAccessories.findByIdAndUpdate(req.user.id, {
          $pull: { ownedAccessories: accessory._id },
        });
        return res.status(402).json({ error: 'Insufficient credits', creditsNeeded: accessory.price });
      }
    }

    res.json({ owned: claimed.ownedAccessories, purchased: accessory._id });
  } catch (error) {
    log.general.error({ err: error }, 'Error purchasing accessory');
    res.status(500).json({ error: 'Failed to purchase accessory' });
  }
});

export default router;
