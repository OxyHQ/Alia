import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  deleteOwnAgentReview,
  findOwnAgentReview,
  listVisibleAgentReviews,
  recalculateAgentRating,
  upsertAgentReview,
} from '../../db/agents/agentReviewRepository.js';
import { hydrateOxyUsers } from '../../lib/oxy-user-hydration.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// GET /agents/:id/reviews - list reviews for an agent
router.get('/:id/reviews', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));

    const agentId = String(req.params.id);
    const { reviews: rows, total } = await listVisibleAgentReviews(getDb(), agentId, {
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
    });

    // `userId` names an Oxy account, not a local document — see
    // lib/oxy-user-hydration.ts. One batch call for the whole page.
    const authors = await hydrateOxyUsers(rows.map((row) => row.userId));
    const reviews = rows.map((row) => ({
      ...row,
      userId: authors.get(row.userId) ?? row.userId,
    }));

    // The author of a withheld review still sees it — a moderation decision must
    // not make somebody's own words vanish without a trace from their side.
    const userReview = req.user?.id
      ? await findOwnAgentReview(getDb(), agentId, req.user.id)
      : null;

    res.json({ reviews, total, userReview });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing reviews');
    res.status(500).json({ error: 'Failed to list reviews' });
  }
});

// POST /agents/:id/reviews - create or update a review
router.post('/:id/reviews', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rating, comment } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const agentId = String(req.params.id);
    const agent = await findAgentById(getDb(), agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Don't allow reviewing your own agent
    if (agent.author === req.user.id) {
      return res.status(400).json({ error: 'Cannot review your own agent' });
    }

    const review = await upsertAgentReview(getDb(), {
      agentId,
      oxyUserId: req.user.id,
      rating: Math.round(rating),
      // `maxlength: 1000` shaped INPUT at the write path and is deliberately not
      // a CHECK, so the clamp stays here — see the schema's note on it.
      comment: (typeof comment === 'string' ? comment : '').slice(0, 1000),
    });

    const stats = await recalculateAgentRating(getDb(), agentId);

    res.json({
      review,
      rating: stats?.avg ?? agent.rating,
      reviewCount: stats?.count ?? agent.reviewCount,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error creating review');
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// DELETE /agents/:id/reviews - delete own review
router.delete('/:id/reviews', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await deleteOwnAgentReview(getDb(), String(req.params.id), req.user.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // The deleted review's own `agentId`, not the path parameter — so the rating
    // is recomputed for the agent the review actually belonged to rather than
    // for whatever the URL claimed.
    await recalculateAgentRating(getDb(), deleted.agentId);

    res.json({ deleted: true });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error deleting review');
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

export default router;
