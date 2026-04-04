import { Router, Request, Response } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import modelsRouter from './v1/models.js';
import { authenticateTokenOrApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { UserCredits } from '../models/user-credits.js';
import { log } from '../lib/logger.js';

const router = Router();


router.get('/', (_req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

// Public routes (no auth required)
router.use('/models', modelsRouter);

// Apply authentication to all other v1 routes (supports both JWT and API keys)
router.use(authenticateTokenOrApiKey);

// Apply rate limiting for API key authenticated requests
router.use(apiKeyRateLimit);

/**
 * GET /v1/me
 * Get current user info (works for any authenticated client)
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user credits
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 300,
          freeLimit: 300,
          dailyRefresh: 300,
          lastRefresh: new Date(),
          paid: 0,
        }
      });
    }

    await userCredits.refreshCreditsIfNeeded();

    res.json({
      id: userId,
      email: (req.user as any)?.email || '',
      name: (req.user as any)?.displayName || (req.user as any)?.email || '',
      credits: {
        free: userCredits.credits.free,
        paid: userCredits.credits.paid,
        total: userCredits.credits.free + userCredits.credits.paid,
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to fetch user info');
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

/**
 * POST /v1/resolve-model
 * Removed: direct provider resolution is internal-only.
 */
router.post('/resolve-model', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Use /v1/chat/completions with Clarity model IDs. Direct model resolution is internal-only.',
  });
});

/**
 * POST /v1/report-usage
 * Removed: usage is tracked internally by the runtime.
 */
router.post('/report-usage', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Usage is tracked automatically by Clarity runtime.',
  });
});

router.use('/chat/completions', chatCompletionsRouter);

export default router;
