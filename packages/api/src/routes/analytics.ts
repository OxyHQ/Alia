import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  aggregateCreditsByDay,
  aggregateUsageByDay,
  aggregateUsageByModel,
} from '../db/usage/chatAnalyticsRepository.js';
import { getRoutingProfile } from '../lib/gateway-client.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(authenticateToken);

/**
 * The window every route here shares: `days` back from now, default 30.
 *
 * The Mongo version additionally cast the account id with
 * `new mongoose.Types.ObjectId(req.user!.id)`, which THREW for any id that was
 * not 24 hex characters and turned into a 500 through the catch. `oxy_user_id`
 * is `text`, so the comparison is now plain equality and that failure mode is
 * gone rather than ported.
 */
function startOfWindow(days: unknown): Date {
  const parsed = parseInt(days as string) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parsed);
  return startDate;
}

// GET /analytics/usage - Usage over time (daily aggregation)
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const usage = await aggregateUsageByDay(getDb(), req.user!.id, startOfWindow(req.query.days));

    res.json({ usage, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch usage analytics' });
  }
});

// GET /analytics/models - Model usage breakdown
router.get('/models', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const raw = await aggregateUsageByModel(getDb(), req.user!.id, startOfWindow(req.query.days));

    /**
     * An entry whose key does not resolve to a Kaana routing profile is DROPPED, never
     * shown under the provider's own name — the model-abstraction rule. The
     * repository groups by `coalesce(routing_profile_id, model)` precisely so this
     * resolves; grouping by the provider id alone would drop everything.
     */
    const models = (await Promise.all(raw.map(async (m) => {
      // The null group first, explicitly: `routing_profile_id` is nullable, so a row
      // written without one groups under NULL and `getRoutingProfile` has nothing to
      // be asked. Dropping it here is the same rule as below, stated where the
      // type makes it reachable rather than left to a coercion.
      if (m._id === null) return null;
      const routingProfile = await getRoutingProfile(m._id);
      if (!routingProfile) return null;
      return {
        ...m,
        name: routingProfile.name,
        emoji: routingProfile.emoji,
      };
    }))).filter(Boolean);

    res.json({ models, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch model analytics' });
  }
});

// GET /analytics/credits - Credit consumption over time
router.get('/credits', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const credits = await aggregateCreditsByDay(getDb(), req.user!.id, startOfWindow(req.query.days));

    res.json({ credits, period: days });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Analytics query failed');
    res.status(500).json({ error: 'Failed to fetch credit analytics' });
  }
});

export default router;
