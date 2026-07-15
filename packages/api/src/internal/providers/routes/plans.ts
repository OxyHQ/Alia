/**
 * Plans API Routes (Admin Only)
 * CRUD for subscription plan definitions
 */

import express, { Request, Response } from 'express';
import { Plan } from '../models/plan.js';
import { AliaModel } from '../models/alia-model.js';
import { broadcastPlansUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/plans
 * List all plans, optionally filtered by product and active status
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { product, active } = req.query;

    const query: Record<string, unknown> = {};
    if (product && typeof product === 'string') query.product = product;
    if (active !== undefined) query.isActive = active === 'true';

    const plans = await Plan.find(query).sort({ product: 1, sortOrder: 1 }).lean();

    res.json({
      success: true,
      count: plans.length,
      data: plans,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing plans');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/plans/:planId
 * Get specific plan
 */
router.get('/:planId', async (req: Request, res: Response) => {
  try {
    const { planId } = req.params;
    const plan = await Plan.findOne({ planId }).lean();

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: plan,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/plans
 * Create new plan
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { planId, name, product, creditsPerMonth, monthlyPrice, annualPrice, currency, ...rest } = req.body;

    if (!planId || !name || !product) {
      return res.status(400).json({
        success: false,
        error: 'planId, name, and product are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!['alia', 'codea'].includes(product)) {
      return res.status(400).json({
        success: false,
        error: 'product must be "alia" or "codea"',
        code: 'INVALID_REQUEST',
      });
    }

    if ((typeof creditsPerMonth === 'number' && creditsPerMonth < 0) ||
        (typeof monthlyPrice === 'number' && monthlyPrice < 0) ||
        (typeof annualPrice === 'number' && annualPrice < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditsPerMonth, monthlyPrice, and annualPrice must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const existing = await Plan.findOne({ planId: planId.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Plan with this ID already exists',
        code: 'PLAN_ALREADY_EXISTS',
      });
    }

    if (rest.modelIds && Array.isArray(rest.modelIds) && rest.modelIds.length > 0) {
      const validModels = await AliaModel.find({ modelId: { $in: rest.modelIds } }).select('modelId').lean();
      const validIds = new Set(validModels.map((m: any) => m.modelId));
      const invalid = rest.modelIds.filter((id: string) => !validIds.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid modelIds: ${invalid.join(', ')}`,
          code: 'INVALID_MODEL_IDS',
        });
      }
    }

    // Whitelist optional fields — never spread req.body directly into create().
    // stripeProductId is excluded: it is server-authoritative, auto-created
    // lazily by ensureStripeProduct() in lib/stripe-prices.ts.
    const optionalFields: Record<string, unknown> = {};
    if ('dailyFreeCredits' in rest) optionalFields.dailyFreeCredits = rest.dailyFreeCredits;
    if ('subtitle' in rest) optionalFields.subtitle = rest.subtitle;
    if ('creditsLabel' in rest) optionalFields.creditsLabel = rest.creditsLabel;
    if ('isFeatured' in rest) optionalFields.isFeatured = rest.isFeatured;
    if ('isFree' in rest) optionalFields.isFree = rest.isFree;
    if ('sortOrder' in rest) optionalFields.sortOrder = rest.sortOrder;
    if ('modelIds' in rest) optionalFields.modelIds = rest.modelIds;
    if ('isActive' in rest) optionalFields.isActive = rest.isActive;
    if ('stripeMonthlyPriceId' in rest) optionalFields.stripeMonthlyPriceId = rest.stripeMonthlyPriceId;
    if ('stripeAnnualPriceId' in rest) optionalFields.stripeAnnualPriceId = rest.stripeAnnualPriceId;
    if ('description' in rest) optionalFields.description = rest.description;
    if ('notes' in rest) optionalFields.notes = rest.notes;

    const plan = await Plan.create({
      planId: planId.toLowerCase(),
      name,
      product,
      creditsPerMonth: creditsPerMonth || 0,
      monthlyPrice: monthlyPrice || 0,
      annualPrice: annualPrice || 0,
      currency: currency || 'usd',
      ...optionalFields,
    });

    res.status(201).json({
      success: true,
      data: plan,
    });

    void broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error creating plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/plans/:planId
 * Update plan configuration
 */
router.patch('/:planId', async (req: Request, res: Response) => {
  try {
    const { planId } = req.params;

    // Explicit whitelist — planId is immutable and excluded on purpose.
    // stripeProductId is excluded: it is server-authoritative, auto-created
    // lazily by ensureStripeProduct() in lib/stripe-prices.ts.
    // Never spread req.body directly into a $set update (mass-assignment).
    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('name' in body) updates.name = body.name;
    if ('product' in body) updates.product = body.product;
    if ('creditsPerMonth' in body) updates.creditsPerMonth = body.creditsPerMonth;
    if ('dailyFreeCredits' in body) updates.dailyFreeCredits = body.dailyFreeCredits;
    if ('monthlyPrice' in body) updates.monthlyPrice = body.monthlyPrice;
    if ('annualPrice' in body) updates.annualPrice = body.annualPrice;
    if ('currency' in body) updates.currency = body.currency;
    if ('subtitle' in body) updates.subtitle = body.subtitle;
    if ('creditsLabel' in body) updates.creditsLabel = body.creditsLabel;
    if ('isFeatured' in body) updates.isFeatured = body.isFeatured;
    if ('isFree' in body) updates.isFree = body.isFree;
    if ('sortOrder' in body) updates.sortOrder = body.sortOrder;
    if ('modelIds' in body) updates.modelIds = body.modelIds;
    if ('isActive' in body) updates.isActive = body.isActive;
    if ('stripeMonthlyPriceId' in body) updates.stripeMonthlyPriceId = body.stripeMonthlyPriceId;
    if ('stripeAnnualPriceId' in body) updates.stripeAnnualPriceId = body.stripeAnnualPriceId;
    if ('description' in body) updates.description = body.description;
    if ('notes' in body) updates.notes = body.notes;

    if (updates.product && (typeof updates.product !== 'string' || !['alia', 'codea'].includes(updates.product))) {
      return res.status(400).json({
        success: false,
        error: 'product must be "alia" or "codea"',
        code: 'INVALID_REQUEST',
      });
    }

    if ((typeof updates.creditsPerMonth === 'number' && updates.creditsPerMonth < 0) ||
        (typeof updates.monthlyPrice === 'number' && updates.monthlyPrice < 0) ||
        (typeof updates.annualPrice === 'number' && updates.annualPrice < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditsPerMonth, monthlyPrice, and annualPrice must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const updateModelIds = updates.modelIds;
    if (Array.isArray(updateModelIds) && updateModelIds.length > 0) {
      const validModels = await AliaModel.find({ modelId: { $in: updateModelIds } }).select('modelId').lean();
      const validIds = new Set(validModels.map((m: any) => m.modelId));
      const invalid = updateModelIds.filter((id: string) => !validIds.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid modelIds: ${invalid.join(', ')}`,
          code: 'INVALID_MODEL_IDS',
        });
      }
    }

    const plan = await Plan.findOneAndUpdate(
      { planId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: plan,
    });

    void broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error updating plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/plans/:planId
 * Delete plan
 */
router.delete('/:planId', async (req: Request, res: Response) => {
  try {
    const { planId } = req.params;

    const plan = await Plan.findOneAndDelete({ planId });

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found',
        code: 'PLAN_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Plan deleted successfully',
    });

    void broadcastPlansUpdate();
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error deleting plan');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
