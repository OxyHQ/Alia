/**
 * Features API Routes (Admin Only)
 * CRUD for canonical feature definitions
 */

import express, { Request, Response } from 'express';
import { Feature } from '../models/feature.js';
import { broadcastFeaturesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/features
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, active } = req.query;
    const query: any = {};
    if (category && typeof category === 'string') query.category = category;
    if (active !== undefined) query.isActive = active === 'true';

    const features = await Feature.find(query).sort({ category: 1, sortOrder: 1 }).lean();
    res.json({ success: true, count: features.length, data: features });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error listing features');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /v1/features/:featureId
 */
router.get('/:featureId', async (req: Request, res: Response) => {
  try {
    const feature = await Feature.findOne({ featureId: req.params.featureId }).lean();
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, data: feature });
  } catch (error: any) {
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

    const existing = await Feature.findOne({ featureId: featureId.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Feature with this ID already exists', code: 'FEATURE_ALREADY_EXISTS' });
    }

    const feature = await Feature.create({
      featureId: featureId.toLowerCase(),
      label,
      category,
      featureType: featureType || 'boolean',
      ...rest,
    });

    res.status(201).json({ success: true, data: feature });
    broadcastFeaturesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error creating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PATCH /v1/features/:featureId
 */
router.patch('/:featureId', async (req: Request, res: Response) => {
  try {
    const updates = { ...req.body };
    delete updates.featureId;

    if (updates.featureType && !['boolean', 'limit'].includes(updates.featureType)) {
      return res.status(400).json({ success: false, error: 'featureType must be "boolean" or "limit"', code: 'INVALID_REQUEST' });
    }

    const feature = await Feature.findOneAndUpdate(
      { featureId: req.params.featureId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }

    res.json({ success: true, data: feature });
    broadcastFeaturesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error updating feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /v1/features/:featureId
 */
router.delete('/:featureId', async (req: Request, res: Response) => {
  try {
    const feature = await Feature.findOneAndDelete({ featureId: req.params.featureId });
    if (!feature) {
      return res.status(404).json({ success: false, error: 'Feature not found', code: 'FEATURE_NOT_FOUND' });
    }
    res.json({ success: true, message: 'Feature deleted successfully' });
    broadcastFeaturesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error deleting feature');
    res.status(500).json({ success: false, error: 'An internal error occurred', code: 'INTERNAL_ERROR' });
  }
});

export default router;
