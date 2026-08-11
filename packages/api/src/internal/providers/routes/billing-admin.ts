/**
 * Billing Admin API Routes
 * Read-only endpoints for viewing transactions, subscriptions, and user summaries
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/index.js';
import {
  countTransactions,
  selectTransactions,
  selectTransactionsForUser,
} from '../../../db/billing/transactionRepository.js';
import {
  countSubscriptions,
  selectSubscriptions,
  selectSubscriptionsForUser,
} from '../../../db/billing/subscriptionRepository.js';
import { findUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

/**
 * GET /v1/billing/transactions
 * List transactions with pagination and optional filters
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { status, type, limit: limitStr, offset: offsetStr } = req.query;

    const filter = {
      ...(status && typeof status === 'string' ? { status } : {}),
      ...(type && typeof type === 'string' ? { type } : {}),
    };

    const limit = Math.min(parseInt(limitStr as string) || 50, 200);
    const offset = parseInt(offsetStr as string) || 0;

    const db = getDb();
    const [transactions, total] = await Promise.all([
      selectTransactions(db, filter, { limit, offset }),
      countTransactions(db, filter),
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

    const filter = {
      ...(status && typeof status === 'string' ? { status } : {}),
      // Mongo's `'plan.product'` — the SNAPSHOT of what was sold.
      ...(product && typeof product === 'string' ? { product } : {}),
    };

    const limit = Math.min(parseInt(limitStr as string) || 50, 200);
    const offset = parseInt(offsetStr as string) || 0;

    const db = getDb();
    const [subscriptions, total] = await Promise.all([
      selectSubscriptions(db, filter, { limit, offset }),
      countSubscriptions(db, filter),
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
    const userId = req.params.userId as string;

    const db = getDb();
    const [credits, subscriptions, transactions] = await Promise.all([
      findUserCredits(db, userId),
      selectSubscriptionsForUser(db, userId),
      selectTransactionsForUser(db, userId, { limit: 50 }),
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
