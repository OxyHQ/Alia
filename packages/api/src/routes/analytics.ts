import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  aggregateCreditsByDay,
  aggregateUsageByDay,
  aggregateUsageByModel,
} from '../db/usage/chatAnalyticsRepository.js';
import { listCatalogueModels } from '../lib/models/catalogue.js';
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
  /**
   * Bounded, because `parseInt(days) || 30` accepted anything a caller typed.
   * `?days=-30` put the start of the window THIRTY DAYS IN THE FUTURE, so
   * every query answered empty and looked like a user with no activity rather
   * than like a bad request; `?days=100000` asked Postgres to scan the whole
   * table. One year is well past any window the dashboards offer.
   */
  const parsed = parseInt(days as string);
  const clamped = Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - clamped);
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
     * Named from the live catalogue. A group the catalogue does not know — a
     * pre-0078 row holding a routing alias or a provider id, a retired model,
     * a local runtime model, or NULL — is dropped rather than shown under a
     * name nothing can vouch for.
     */
    const catalogue = await listCatalogueModels().catch(() => []);
    const byId = new Map(catalogue.map((model) => [model.id, model]));
    const models = raw.flatMap((m) => {
      const model = m._id === null ? undefined : byId.get(m._id);
      return model === undefined ? [] : [{ ...m, name: model.name, publisher: model.publisher }];
    });

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
