/**
 * PlanFeatures API Routes (Admin Only)
 * Manage plan-feature mappings: list, matrix view, upsert, bulk update
 */

import express, { Request, Response } from 'express';
import { PlanFeature } from '../models/plan-feature.js';
import { Feature } from '../models/feature.js';
import { Plan, type IPlan } from '../models/plan.js';
import { broadcastPlanFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/plan-features?planId=
 * List plan-feature mappings, optionally filtered by planId
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { planId } = req.query;
    const query: Record<string, string> = {};
    if (planId && typeof planId === 'string') query.planId = planId;

    const mappings = await PlanFeature.find(query).sort({ planId: 1, featureId: 1 }).lean();
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
    const [features, plans, mappings] = await Promise.all([
      Feature.find({ isActive: true }).sort({ category: 1, sortOrder: 1 }).lean(),
      Plan.find({ isActive: true }).sort({ product: 1, sortOrder: 1 }).lean(),
      PlanFeature.find({}).lean(),
    ]);

    // Build lookup: planId:featureId -> mapping
    const mappingMap: Record<string, typeof mappings[number]> = {};
    for (const m of mappings) {
      mappingMap[`${m.planId}:${m.featureId}`] = m;
    }

    res.json({
      success: true,
      data: {
        features,
        plans: plans.map(p => ({ planId: (p as IPlan).planId, name: p.name, product: p.product })),
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
    const { planId, featureId } = req.params;
    const { enabled, limitValue, displayLabel, displayDescription } = req.body;

    const mapping = await PlanFeature.findOneAndUpdate(
      { planId, featureId },
      {
        $set: {
          enabled: enabled ?? true,
          limitValue,
          displayLabel,
          displayDescription,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    res.json({ success: true, data: mapping });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
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

    interface BulkMappingInput {
      planId: string;
      featureId: string;
      enabled?: boolean;
      limitValue?: number;
      displayLabel?: string;
      displayDescription?: string;
    }

    const ops = (mappings as BulkMappingInput[]).map((m) => ({
      updateOne: {
        filter: { planId: m.planId, featureId: m.featureId },
        update: {
          $set: {
            enabled: m.enabled ?? true,
            limitValue: m.limitValue,
            displayLabel: m.displayLabel,
            displayDescription: m.displayDescription,
          },
        },
        upsert: true,
      },
    }));

    const result = await PlanFeature.bulkWrite(ops);

    res.json({
      success: true,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
      total: ops.length,
    });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
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
    const { planId, featureId } = req.params;
    const result = await PlanFeature.findOneAndDelete({ planId, featureId });
    if (!result) {
      return res.status(404).json({ success: false, error: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Mapping deleted' });
    broadcastPlanFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting plan-feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
