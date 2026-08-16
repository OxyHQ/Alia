import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { handleChatCompletions } from './v1/chat-completions.js';

const router = Router();

/**
 * Unified runtime: internal chat uses the same handler as `/v1/chat/completions`.
 *
 * `apiKeyRateLimit` is here for the same reason it is on `/v1` (`routes/v1.ts`):
 * this route reaches the identical inference handler, so an authenticated caller
 * who moved from one path to the other was previously moving out of the limiter
 * — the limit belongs to the WORK, not to the URL that asked for it. Epic #139
 * workstream 15, *"Add rate limits and circuit protection at the Alia
 * boundary"*, and pinned by `routes/__tests__/inference-boundary.test.ts`.
 *
 * `optionalAuth` and not `authenticateTokenOrApiKey`: an anonymous POST here
 * still reaches inference with no credit reservation, which is a real gap and a
 * PRODUCT decision (whether this surface is public) rather than a rate-limiting
 * one. It is recorded at the assertion in that test rather than changed here.
 */
router.post('/', optionalAuth, apiKeyRateLimit, handleChatCompletions);

router.get('/', async (_req, res) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    endpoint: '/alia/chat',
    runtime: 'autonomy-v1',
  });
});

export default router;
