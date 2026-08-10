/**
 * Features API Routes (Admin Only)
 * CRUD for canonical feature definitions
 */

import express, { Request, Response } from 'express';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../../../db/index.js';
import {
  deleteFeatureByFeatureId,
  findFeatureByFeatureId,
  insertFeature,
  selectFeatures,
  updateFeatureByFeatureId,
  type FeatureUpdate,
} from '../../../db/billing/featureRepository.js';
import { broadcastFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/features
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, active } = req.query;
    const features = await selectFeatures(getDb(), {
      ...(category && typeof category === 'string' ? { category } : {}),
      ...(active !== undefined ? { isActive: active === 'true' } : {}),
    });
    res.json({ success: true, count: features.length, data: features });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /v1/features/:featureId
 */
router.get('/:featureId', async (req: Request, res: Response) => {
  try {
    const feature = await findFeatureByFeatureId(getDb(), req.params.featureId as string);
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, data: feature });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /v1/features
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { featureId, label, category, featureType, ...rest } = req.body;

    if (!featureId || !label || !category) {
      return res.status(400).json({ success: false, error: 'featureId, label, and category are required', code: 'INVALID_REQUEST' });
    }
    if (featureType && !['boolean', 'limit'].includes(featureType)) {
      return res.status(400).json({ success: false, error: 'featureType must be "boolean" or "limit"', code: 'INVALID_REQUEST' });
    }

    const existing = await findFeatureByFeatureId(getDb(), featureId.toLowerCase());
    if (existing) {
      return res.status(409).json({ success: false, error: 'Feature with this ID already exists', code: 'FEATURE_ALREADY_EXISTS' });
    }

    // Whitelist optional fields — never spread req.body directly into create()
    const optionalFields: Record<string, unknown> = {};
    if ('description' in rest) optionalFields.description = rest.description;
    if ('icon' in rest) optionalFields.icon = rest.icon;
    if ('sortOrder' in rest) optionalFields.sortOrder = rest.sortOrder;
    if ('isVisibleOnPricing' in rest) optionalFields.isVisibleOnPricing = rest.isVisibleOnPricing;
    if ('isActive' in rest) optionalFields.isActive = rest.isActive;

    const feature = await insertFeature(getDb(), {
      featureId: featureId.toLowerCase(),
      label,
      category,
      featureType: featureType || 'boolean',
      ...optionalFields,
    });

    res.status(201).json({ success: true, data: feature });
    void broadcastFeaturesUpdate();
  } catch (error: unknown) {
    // `features_feature_id_key` is what actually holds; the pre-check above is a
    // read-then-write race that a concurrent create would win.
    if (isUniqueViolation(error)) {
      return res.status(409).json({ success: false, error: 'Feature with this ID already exists', code: 'FEATURE_ALREADY_EXISTS' });
    }
    log.providers.error({ err: error }, 'Error creating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PATCH /v1/features/:featureId
 */
router.patch('/:featureId', async (req: Request, res: Response) => {
  try {
    // Explicit whitelist — featureId is immutable and excluded on purpose;
    // never spread req.body directly into a $set update (mass-assignment).
    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('label' in body) updates.label = body.label;
    if ('description' in body) updates.description = body.description;
    if ('icon' in body) updates.icon = body.icon;
    if ('category' in body) updates.category = body.category;
    if ('featureType' in body) updates.featureType = body.featureType;
    if ('sortOrder' in body) updates.sortOrder = body.sortOrder;
    if ('isVisibleOnPricing' in body) updates.isVisibleOnPricing = body.isVisibleOnPricing;
    if ('isActive' in body) updates.isActive = body.isActive;

    if (updates.featureType && (typeof updates.featureType !== 'string' || !['boolean', 'limit'].includes(updates.featureType))) {
      return res.status(400).json({ success: false, error: 'featureType must be "boolean" or "limit"', code: 'INVALID_REQUEST' });
    }

    const feature = await updateFeatureByFeatureId(
      getDb(),
      req.params.featureId as string,
      updates as FeatureUpdate,
    );

    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }

    res.json({ success: true, data: feature });
    void broadcastFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /v1/features/:featureId
 */
router.delete('/:featureId', async (req: Request, res: Response) => {
  try {
    const feature = await deleteFeatureByFeatureId(getDb(), req.params.featureId as string);
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Feature deleted successfully' });
    void broadcastFeaturesUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
