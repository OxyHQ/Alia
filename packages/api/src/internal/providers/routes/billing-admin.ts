/**
 * Billing Admin API Routes
 * Read-only endpoints for viewing transactions, subscriptions, and user summaries
 */

import express, { Request, Response } from 'express';
import { Transaction } from '../../../models/transaction.js';
import { Subscription } from '../../../models/subscription.js';
import { UserCredits } from '../../../models/user-credits.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/billing/transactions
 * List transactions with pagination and optional filters
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { status, type, limit: limitStr, offset: offsetStr } = req.query;

    const query: Record<string, unknown> = {};
    if (status && typeof status === 'string') query.status = status;
    if (type && typeof type === 'string') query.type = type;

    const limit = Math.min(parseInt(limitStr as string) || 50, 200);
    const offset = parseInt(offsetStr as string) || 0;

    const [transactions, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: transactions.length,
      total,
      data: transactions,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing transactions');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/billing/subscriptions
 * List subscriptions with pagination and optional filters
 */
router.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const { status, product, limit: limitStr, offset: offsetStr } = req.query;

    const query: Record<string, unknown> = {};
    if (status && typeof status === 'string') query.status = status;
    if (product && typeof product === 'string') query['plan.product'] = product;

    const limit = Math.min(parseInt(limitStr as string) || 50, 200);
    const offset = parseInt(offsetStr as string) || 0;

    const [subscriptions, total] = await Promise.all([
      Subscription.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      Subscription.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: subscriptions.length,
      total,
      data: subscriptions,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing subscriptions');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/billing/user/:userId
 * Get billing summary for a specific user
 */
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const [credits, subscriptions, transactions] = await Promise.all([
      UserCredits.findById(userId).lean(),
      Subscription.find({ oxyUserId: userId }).sort({ createdAt: -1 }).lean(),
      Transaction.find({ oxyUserId: userId }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);

    res.json({
      success: true,
      data: {
        credits,
        subscriptions,
        transactions,
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting user billing summary');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
