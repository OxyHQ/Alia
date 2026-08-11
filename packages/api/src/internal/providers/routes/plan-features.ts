/**
 * PlanFeatures API Routes (Admin Only)
 * Manage plan-feature mappings: list, matrix view, upsert, bulk update
 */

import express, { Request, Response } from 'express';
import { isForeignKeyViolation } from '@oxyhq/db';
import { getDb } from '../../../db/index.js';
import {
  bulkUpsertPlanFeatures,
  deletePlanFeature,
  selectAllPlanFeatures,
  selectPlanFeatures,
  upsertPlanFeature,
} from '../../../db/billing/planFeatureRepository.js';
import { selectFeatures } from '../../../db/billing/featureRepository.js';
import { selectPlans } from '../../../db/billing/planRepository.js';
import { broadcastPlanFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

/**
 * A mapping naming a plan or feature that does not exist is REFUSED by the
 * foreign keys, where Mongo created an orphan. `23503` becomes a 400 rather than
 * a 500 — the request is wrong, not the server.
 */
const UNKNOWN_MAPPING_TARGET = {
  success: false,
  error: 'planId and featureId must name an existing plan and feature',
  code: 'UNKNOWN_MAPPING_TARGET',
} as const;

const router = express.Router();

/**
 * GET /v1/plan-features?planId=
 * List plan-feature mappings, optionally filtered by planId
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { planId } = req.query;
    const mappings = await selectPlanFeatures(getDb(), {
      ...(planId && typeof planId === 'string' ? { planId } : {}),
    });
    res.json({ success: true, count: mappings.length, data: mappings });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing plan-features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /v1/plan-features/matrix
 * Full matrix: all plans x all features for the admin grid editor
 */
router.get('/matrix', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const [features, plans, mappings] = await Promise.all([
      selectFeatures(db, { isActive: true }),
      selectPlans(db, { isActive: true }),
      selectAllPlanFeatures(db),
    ]);

    // Build lookup: planId:featureId -> mapping
    const mappingMap: Record<string, (typeof mappings)[number]> = {};
    for (const m of mappings) {
      mappingMap[`${m.planId}:${m.featureId}`] = m;
    }

    res.json({
      success: true,
      data: {
        features,
        plans: plans.map(p => ({ planId: p.planId, name: p.name, product: p.product })),
        mappings: mappingMap,
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error building plan-features matrix');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /v1/plan-features/:planId/:featureId
 * Upsert a single plan-feature mapping
 */
router.put('/:planId/:featureId', async (req: Request, res: Response) => {
  try {
    const planId = req.params.planId as string;
    const featureId = req.params.featureId as string;
    const { enabled, limitValue, displayLabel, displayDescription } = req.body;

    const mapping = await upsertPlanFeature(getDb(), planId, featureId, {
      enabled: enabled ?? true,
      limitValue,
      displayLabel,
      displayDescription,
    });

    res.json({ success: true, data: mapping });
    void broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) return res.status(400).json(UNKNOWN_MAPPING_TARGET);
    log.providers.error({ err: error }, 'Error upserting plan-feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /v1/plan-features/bulk
 * Bulk upsert plan-feature mappings from the matrix editor "Save All"
 * Body: { mappings: Array<{ planId, featureId, enabled, limitValue?, displayLabel?, displayDescription? }> }
 */
router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ success: false, error: 'mappings must be an array', code: 'INVALID_REQUEST' });
    }

    const ops = (mappings as Array<Record<string, unknown>>).map((m) => ({
      planId: String(m.planId),
      featureId: String(m.featureId),
      values: {
        enabled: (m.enabled as boolean | undefined) ?? true,
        limitValue: m.limitValue as number | null | undefined,
        displayLabel: m.displayLabel as string | null | undefined,
        displayDescription: m.displayDescription as string | null | undefined,
      },
    }));

    const result = await bulkUpsertPlanFeatures(getDb(), ops);

    res.json({
      success: true,
      upserted: result.upserted,
      modified: result.modified,
      total: ops.length,
    });
    void broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) return res.status(400).json(UNKNOWN_MAPPING_TARGET);
    log.providers.error({ err: error }, 'Error bulk upserting plan-features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /v1/plan-features/:planId/:featureId
 * Remove a single plan-feature mapping
 */
router.delete('/:planId/:featureId', async (req: Request, res: Response) => {
  try {
    const planId = req.params.planId as string;
    const featureId = req.params.featureId as string;
    const result = await deletePlanFeature(getDb(), planId, featureId);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Mapping deleted' });
    void broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting plan-feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
