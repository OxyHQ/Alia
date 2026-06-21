/**
 * CreditPackages API Routes (Admin Only)
 * CRUD for one-time credit purchase packages
 */

import express, { Request, Response } from 'express';
import { CreditPackage } from '../models/credit-package.js';
import { broadcastCreditPackagesUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/credit-packages
 * List all credit packages, optionally filtered by active status
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { active } = req.query;

    const query: any = {};
    if (active !== undefined) query.isActive = active === 'true';

    const packages = await CreditPackage.find(query).sort({ sortOrder: 1 }).lean();

    res.json({
      success: true,
      count: packages.length,
      data: packages,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error listing credit packages');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/credit-packages/:packageId
 * Get specific credit package
 */
router.get('/:packageId', async (req: Request, res: Response) => {
  try {
    const { packageId } = req.params;
    const pkg = await CreditPackage.findOne({ packageId }).lean();

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: pkg,
    });
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error getting credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/credit-packages
 * Create new credit package
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { packageId, name, credits, price, currency, ...rest } = req.body;

    if (!packageId || !name) {
      return res.status(400).json({
        success: false,
        error: 'packageId and name are required',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof credits !== 'number' || credits < 1) {
      return res.status(400).json({
        success: false,
        error: 'credits must be a positive number',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof price !== 'number' || price < 0) {
      return res.status(400).json({
        success: false,
        error: 'price must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const existing = await CreditPackage.findOne({ packageId: packageId.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Credit package with this ID already exists',
        code: 'PACKAGE_ALREADY_EXISTS',
      });
    }

    const pkg = await CreditPackage.create({
      packageId: packageId.toLowerCase(),
      name,
      credits,
      price,
      currency: currency || 'usd',
      ...rest,
    });

    res.status(201).json({
      success: true,
      data: pkg,
    });

    broadcastCreditPackagesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error creating credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/credit-packages/:packageId
 * Update credit package
 */
router.patch('/:packageId', async (req: Request, res: Response) => {
  try {
    const { packageId } = req.params;
    const updates = { ...req.body };

    // Don't allow changing packageId
    delete updates.packageId;

    if (typeof updates.credits === 'number' && updates.credits < 1) {
      return res.status(400).json({
        success: false,
        error: 'credits must be a positive number',
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof updates.price === 'number' && updates.price < 0) {
      return res.status(400).json({
        success: false,
        error: 'price must not be negative',
        code: 'INVALID_REQUEST',
      });
    }

    const pkg = await CreditPackage.findOneAndUpdate(
      { packageId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: pkg,
    });

    broadcastCreditPackagesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error updating credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/credit-packages/:packageId
 * Delete credit package
 */
router.delete('/:packageId', async (req: Request, res: Response) => {
  try {
    const { packageId } = req.params;

    const pkg = await CreditPackage.findOneAndDelete({ packageId });

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: 'Credit package not found',
        code: 'PACKAGE_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      message: 'Credit package deleted successfully',
    });

    broadcastCreditPackagesUpdate();
  } catch (error: any) {
    log.providers.error({ err: error }, 'Error deleting credit package');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
