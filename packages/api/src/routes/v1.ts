import { Router, type Request, type Response } from 'express';
import type { User } from '@oxy.so/core';
import chatCompletionsRouter from './v1/chat-completions.js';
import responsesRouter from './v1/responses.js';
import modelsRouter from './v1/models.js';
import audioRouter from './v1/audio.js';
import imagesRouter from './v1/images.js';
import conversationsRouter from './conversations.js';
import sharedRouter from './shared.js';
import agentsV1Router from './v1/agents.js';
import { cancelChatTurn } from '../lib/chat/turn-control.js';
import { authenticateToken, authenticateTokenOrApiKey, oxyClient } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { getRefreshedUserCredits } from '../lib/user-credits-helpers.js';
import { log } from '../lib/logger.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0',
  });
});

// Public routes (no auth required)
router.use('/models', modelsRouter);

/**
 * The person's conversations, on the product API — the one the SDK talks to.
 *
 * `@alia.onl/sdk` is embedded by every Oxy app, on their own web origins, so it can only call
 * a surface with public CORS (this one: `cors({ origin: '*' })` in `index.ts`, bearer and no
 * cookies). The SAME router `/conversations` mounts, so there is one implementation and one
 * set of rules; only the door differs.
 *
 * ## Persons only
 *
 * A conversation is somebody's private history, so this door admits a person's Oxy session (a
 * user bearer, or a service token acting for a person under an acting-as grant — both are
 * `authenticateToken`) and nothing else: no `oxy_sk_` application key (it is already refused
 * for every route but the two chat ones), no channel-bot or Telegram secret (those bots keep
 * the server-to-server `/conversations`). The owner's data only with
 * the owner present: a third party's key has no owner present to speak for. It is mounted
 * BEFORE the inline channel-bot middleware and the blanket `authenticateTokenOrApiKey` below
 * for exactly that reason.
 */
router.use('/conversations', authenticateToken, apiKeyRateLimit, conversationsRouter);

// A shared conversation is read by whoever holds its link: no auth, by design
// (`routes/shared.ts`).
router.use('/shared', sharedRouter);

// What an embedding app reads about an agent before opening it: the person's own session.
router.use('/agents', authenticateToken, apiKeyRateLimit, agentsV1Router);

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
      oxyUser = await oxyClient.users.get(userId);
    } catch (err) {
      log.general.warn({ err, userId }, 'Failed to load Oxy user for /v1/me');
    }

    // Get user credits
    const userCredits = await getRefreshedUserCredits(userId);

    res.json({
      id: userId,
      email: oxyUser?.email || req.user?.email || '',
      name: oxyUser?.name?.displayName || oxyUser?.username || req.user?.email || '',
      credits: {
        free: userCredits.creditsFree,
        paid: userCredits.creditsPaid,
        total: userCredits.creditsFree + userCredits.creditsPaid,
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
    message:
      'Use /v1/chat/completions with a model id from GET /v1/models. Direct model resolution is internal-only.',
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
router.post('/chat/turns/:turnId/cancel', cancelChatTurn);

// OpenAI Responses API support (for Vercel AI SDK compatibility)
router.use('/responses', responsesRouter);

// Audio (TTS + generation)
router.use('/audio', audioRouter);

// Image generation
router.use('/images', imagesRouter);

export default router;
