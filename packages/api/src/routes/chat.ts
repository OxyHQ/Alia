import { Router } from 'express';
import { authenticateTokenOrApiKey } from '../middleware/auth.js';
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
 * ## Why this is `authenticateTokenOrApiKey` and not `optionalAuth`
 *
 * It was `optionalAuth` until #139 workstream 6, and the consequence was not a
 * lenient session model — it was free inference. An anonymous POST reached this
 * handler, `apiKeyRateLimit` found neither `req.apiKey` nor `req.user` and fell
 * through to a bare `next()`, and `lib/chat/request-context.ts` gates the credit
 * reservation on `(req.user && !req.serviceApp)`, so the work ran unlimited and
 * METERED TO NOBODY. `/v1/chat/completions` — the identical handler — answered
 * the identical request with 401 the whole time.
 *
 * Closed rather than split, because ADR 0004 rejects the split by name:
 * *"Keep one handler for both surfaces and gate behaviour on the caller's
 * credential type. Rejected."* An auth difference between two mounts of one
 * handler IS such a gate, and it is the divergence that ADR asks not to exist
 * silently. Every remaining difference between the two surfaces is enumerated in
 * `routes/__tests__/v1-compatibility-surface.test.ts`.
 *
 * The cost of closing it in this repository is zero — nothing calls this route
 * (`packages/app/lib/api/routes.ts` declares `API_ROUTES.chat.alia` and no file
 * reads it) — and outside it the affected population is callers who were not
 * authenticating, which is the same set as callers whose usage was attributed to
 * nobody and whose conversations were never persisted.
 */
router.post('/', authenticateTokenOrApiKey, apiKeyRateLimit, handleChatCompletions);

/**
 * The status banner stays public.
 *
 * It reaches no inference, spends nothing and names no user, and ws1's inventory
 * records that its `runtime: 'autonomy-v1'` string may be what an uptime monitor
 * matches on (`docs/migration/inventories/product-api.json`, `alia-chat-get`).
 * Authenticating a liveness probe would break that for no gain.
 */
router.get('/', async (_req, res) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    endpoint: '/alia/chat',
    runtime: 'autonomy-v1',
  });
});

export default router;
