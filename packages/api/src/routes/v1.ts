import { Router, Request, Response } from 'express';
import type { User } from '@oxyhq/core';
import chatCompletionsRouter from './v1/chat-completions.js';
import responsesRouter from './v1/responses.js';
import modelsRouter from './v1/models.js';
import voiceRouter from './v1/voice.js';
import audioRouter from './v1/audio.js';
import imagesRouter from './v1/images.js';
import showsRouter from './v1/shows.js';
import { authenticateTokenOrApiKey, optionalAuth, oxyClient } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { UserCredits } from '../models/user-credits.js';
import { listChannels } from '../lib/channels/registry.js';
import * as crypto from 'crypto';
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

// Shows: use optionalAuth so unauthenticated users get empty results instead of 401
router.use('/shows', optionalAuth, showsRouter);

// Channel bot auth: validates x-channel-bot-secret against registered channels
// and sets req.user from x-oxy-user-id for trusted bot services.
router.use((req: Request, _res: Response, next) => {
  const botSecret = req.headers['x-channel-bot-secret'] as string;
  const oxyUserId = req.headers['x-oxy-user-id'] as string;
  if (!botSecret || !oxyUserId) return next();

  // Validate oxyUserId is a valid 24-char hex ObjectId to prevent injection
  if (!/^[a-f0-9]{24}$/.test(oxyUserId)) return next();

  for (const channel of listChannels()) {
    const expected = channel.config.getBotSecret();
    if (!expected) continue;
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(botSecret);
    if (expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      req.user = { id: oxyUserId };
      req.channelType = channel.id;
      return next();
    }
  }
  next();
});

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

    // Load the canonical Oxy user so we can emit the authoritative
    // `name.displayName` (the auth middleware only plants `{ id }`). Best-effort:
    // a profile-fetch failure must not block the credits payload.
    let oxyUser: User | null = null;
    try {
      oxyUser = await oxyClient.getUserById(userId);
    } catch (err) {
      log.general.warn({ err, userId }, 'Failed to load Oxy user for /v1/me');
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
      email: oxyUser?.email || req.user?.email || '',
      name: oxyUser?.name?.displayName || oxyUser?.username || req.user?.email || '',
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
    message: 'Use /v1/chat/completions with Alia model IDs. Direct model resolution is internal-only.',
  });
});

/**
 * POST /v1/report-usage
 * Removed: usage is tracked internally by the runtime.
 */
router.post('/report-usage', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Usage is tracked automatically by Alia runtime.',
  });
});

router.use('/chat/completions', chatCompletionsRouter);

// OpenAI Responses API support (for Vercel AI SDK compatibility)
router.use('/responses', responsesRouter);

// Voice mode (LiveKit token + transcription)
router.use('/voice', voiceRouter);

// Audio (TTS + generation)
router.use('/audio', audioRouter);

// Image generation
router.use('/images', imagesRouter);

// Podcast generation (mounted above with optionalAuth)

export default router;
