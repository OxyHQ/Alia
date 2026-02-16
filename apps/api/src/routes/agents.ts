import { Router } from 'express';
import { Agent } from '../models/agent.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// GET /agents - list published agents (public, optional auth)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { category, search, featured, trending, page = '1', limit = '50' } = req.query;

    const filter: any = { isPublished: true };

    if (category && category !== 'all') {
      filter.category = category;
    }

    if (featured === 'true') {
      filter.isFeatured = true;
    }

    if (trending === 'true') {
      filter.isTrending = true;
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search, 'i');
      filter.$or = [
        { name: regex },
        { handle: regex },
        { tagline: regex },
        { category: regex },
        { tags: regex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [agents, total] = await Promise.all([
      Agent.find(filter)
        .sort({ isFeatured: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Agent.countDocuments(filter),
    ]);

    res.json({ agents, total, page: pageNum, limit: limitNum });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing agents');
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// GET /agents/me - list current user's agents (must be before /:id)
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agents = await Agent.find({ author: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ agents });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing user agents');
    res.status(500).json({ error: 'Failed to list your agents' });
  }
});

// GET /agents/:id - get single agent (public)
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await Agent.findById(req.params.id).lean();

    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting agent');
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// POST /agents - create agent
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      name, handle, avatar, banner, bannerGradient,
      tagline, description, category, tags, price,
      capabilities, isPublished, creditBalance, allowHiring,
    } = req.body;

    if (!name || !handle || !tagline || !description || !category) {
      return res.status(400).json({
        error: 'name, handle, tagline, description, and category are required',
      });
    }

    const existing = await Agent.findOne({ handle });
    if (existing) {
      return res.status(409).json({ error: 'Handle already taken' });
    }

    const agent = await Agent.create({
      name,
      handle,
      avatar: avatar || null,
      banner: banner || null,
      bannerGradient: bannerGradient || ['#6366f1', '#8b5cf6'],
      tagline,
      description,
      author: req.user.id,
      authorName: req.user.username || 'Unknown',
      authorVerified: false,
      category,
      tags: tags || [],
      price: price ?? null,
      capabilities: capabilities || [],
      isPublished: isPublished ?? true,
      creditBalance: creditBalance ?? 0,
      allowHiring: allowHiring ?? false,
    });

    res.status(201).json({ agent });
  } catch (error) {
    log.agents.error({ err: error }, 'Error creating agent');
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// PATCH /agents/:id - update agent (owner only)
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findOne({
      _id: req.params.id,
      author: req.user.id,
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const allowedFields = [
      'name', 'avatar', 'banner', 'bannerGradient', 'tagline',
      'description', 'category', 'tags', 'price', 'capabilities',
      'isPublished', 'status', 'creditBalance', 'allowHiring',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (agent as any)[field] = req.body[field];
      }
    }

    await agent.save();
    res.json({ agent });
  } catch (error) {
    log.agents.error({ err: error }, 'Error updating agent');
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// DELETE /agents/:id - delete agent (owner only)
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await Agent.deleteOne({
      _id: req.params.id,
      author: req.user.id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ success: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error deleting agent');
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// POST /agents/:id/follow - toggle follow
router.post('/:id/follow', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findById(req.params.id);
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    agent.followerCount += 1;
    await agent.save();

    res.json({ agent, followed: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error following agent');
    res.status(500).json({ error: 'Failed to follow agent' });
  }
});

// POST /agents/:id/hire - hire/use agent
router.post('/:id/hire', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findById(req.params.id);
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // TODO: Handle payment/credits for paid agents
    agent.hireCount += 1;
    agent.usageCount += 1;
    await agent.save();

    res.json({ agent, hired: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error hiring agent');
    res.status(500).json({ error: 'Failed to hire agent' });
  }
});

export default router;
