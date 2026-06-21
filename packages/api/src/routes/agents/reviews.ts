import { Router } from 'express';
import { Agent } from '../../models/agent.js';
import { AgentReview } from '../../models/agent-review.js';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// GET /agents/:id/reviews - list reviews for an agent
router.get('/:id/reviews', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));

    const reviews = await AgentReview.find({ agentId: req.params.id })
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('userId', 'username avatar')
      .lean();

    const total = await AgentReview.countDocuments({ agentId: req.params.id });

    // Check if current user has reviewed
    let userReview = null;
    if (req.user?.id) {
      userReview = await AgentReview.findOne({
        agentId: req.params.id,
        userId: req.user.id,
      }).lean();
    }

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

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const agent = await Agent.findById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Don't allow reviewing your own agent
    if (agent.author.toString() === req.user.id) {
      return res.status(400).json({ error: 'Cannot review your own agent' });
    }

    // Upsert review (one per user per agent)
    const review = await AgentReview.findOneAndUpdate(
      { agentId: req.params.id, userId: req.user.id },
      { rating: Math.round(rating), comment: (comment || '').slice(0, 1000) },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    // Recalculate agent rating
    const stats = await AgentReview.aggregate([
      { $match: { agentId: agent._id } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);

    if (stats.length > 0) {
      agent.rating = Math.round(stats[0].avg * 10) / 10;
      agent.reviewCount = stats[0].count;
      await agent.save();
    }

    res.json({ review, rating: agent.rating, reviewCount: agent.reviewCount });
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

    const result = await AgentReview.findOneAndDelete({
      agentId: req.params.id,
      userId: req.user.id,
    });

    if (!result) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Recalculate agent rating
    const agent = await Agent.findById(req.params.id);
    if (agent) {
      const stats = await AgentReview.aggregate([
        { $match: { agentId: agent._id } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]);

      if (stats.length > 0) {
        agent.rating = Math.round(stats[0].avg * 10) / 10;
        agent.reviewCount = stats[0].count;
      } else {
        agent.rating = 0;
        agent.reviewCount = 0;
      }
      await agent.save();
    }

    res.json({ deleted: true });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error deleting review');
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

export default router;
