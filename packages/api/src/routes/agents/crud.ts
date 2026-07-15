import { Router } from 'express';
import { Agent, type IAgent } from '../../models/agent.js';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getAgentCapabilities } from '../../lib/agent/health.js';
import { Trigger } from '../../models/trigger.js';
import { reloadTrigger, generateWebhookToken } from '../../lib/trigger-engine.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// ── Archetype Trigger Sync ──────────────────────────────────────────

/**
 * Sync triggers for archetype agents:
 * - status_update: auto-create/update schedule trigger
 * - task_router: auto-create webhook trigger if 'webhook' channel configured
 */
async function syncArchetypeTriggers(
  agentId: string,
  userId: string,
  agent: Pick<IAgent, 'archetype' | 'archetypeConfig' | 'name'>,
): Promise<void> {
  const config = agent.archetypeConfig;
  if (!config) return;

  if (agent.archetype === 'status_update' && config.schedule) {
    const existing = await Trigger.findOne({
      'action.agentId': agentId,
      type: 'schedule',
      oxyUserId: userId,
    });

    const triggerSchedule = {
      type: config.schedule.type || 'daily',
      ...(config.schedule.time && { time: config.schedule.time }),
      ...(config.schedule.days && { days: config.schedule.days }),
      ...(config.schedule.intervalMinutes && { intervalMinutes: config.schedule.intervalMinutes }),
      ...(config.schedule.cron && { cron: config.schedule.cron }),
    };

    const reportPrompt = config.reportTemplate
      ? `Generate a status report following this template:\n\n${config.reportTemplate}`
      : 'Generate a comprehensive status update report from all configured data sources.';

    if (existing) {
      existing.schedule = triggerSchedule as any;
      existing.action.prompt = reportPrompt;
      existing.name = `${agent.name || 'Agent'} Report`;
      await existing.save();
      await reloadTrigger(existing._id.toString());
    } else {
      const trigger = await Trigger.create({
        oxyUserId: userId,
        name: `${agent.name || 'Agent'} Report`,
        description: `Scheduled status report from ${agent.name || 'agent'}`,
        type: 'schedule',
        enabled: true,
        action: {
          prompt: reportPrompt,
          agentId,
          useTools: true,
          notify: true,
          ...(config.deliveryChannels?.[0] && { channelId: config.deliveryChannels[0] }),
        },
        schedule: triggerSchedule,
        triggerCount: 0,
      });
      await reloadTrigger(trigger._id.toString());
    }
  }

  if (agent.archetype === 'task_router' && config.inboundChannels?.includes('webhook')) {
    const existing = await Trigger.findOne({
      'action.agentId': agentId,
      type: 'webhook',
      oxyUserId: userId,
    });

    if (!existing) {
      await Trigger.create({
        oxyUserId: userId,
        name: `${agent.name || 'Agent'} Webhook`,
        description: `Inbound webhook for task routing by ${agent.name || 'agent'}`,
        type: 'webhook',
        enabled: true,
        action: {
          prompt: 'Process and route this incoming task.',
          agentId,
          useTools: true,
          notify: true,
        },
        webhook: {
          token: generateWebhookToken(),
        },
        triggerCount: 0,
      });
    }
  }
}

// GET /agents - list published agents (public, optional auth)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { category, search, featured, trending, page = '1', limit = '50' } = req.query;

    const filter: Record<string, unknown> = { isPublished: true };

    if (category && category !== 'all') {
      filter.category = category;
    }

    if (req.query.archetype && typeof req.query.archetype === 'string') {
      filter.archetype = req.query.archetype;
    }

    if (featured === 'true') {
      filter.isFeatured = true;
    }

    if (trending === 'true') {
      filter.isTrending = true;
    }

    if (search && typeof search === 'string') {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
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
        .select('-systemPrompt -skills -knowledge')
        .sort({ isFeatured: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Agent.countDocuments(filter),
    ]);

    res.json({ agents, total, page: pageNum, limit: limitNum });
  } catch (error: unknown) {
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
      .populate('skills', 'skillId title icon color')
      .populate('knowledge', 'name type category url')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ agents });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing user agents');
    res.status(500).json({ error: 'Failed to list your agents' });
  }
});

// GET /agents/health - infrastructure status
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const capabilities = await getAgentCapabilities();
    res.json({ capabilities });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error checking agent health');
    res.status(500).json({ error: 'Failed to check health' });
  }
});

// GET /agents/:id - get single agent (public)
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await Agent.findById(req.params.id)
      .populate('skills', 'skillId title icon color')
      .populate('knowledge', 'name type category url')
      .lean();

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow owner to view unpublished (draft) agents
    if (!agent.isPublished && (!req.user?.id || agent.author.toString() !== req.user.id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent });
  } catch (error: unknown) {
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
      name, handle, avatar,
      tagline, description, category, tags, price,
      capabilities, skills, knowledge,
      isPublished, creditBalance, allowHiring,
      systemPrompt, archetype, archetypeConfig,
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
      tagline,
      description,
      author: req.user.id,
      authorName: req.user.username || 'Unknown',
      authorVerified: false,
      category,
      tags: tags || [],
      price: price ?? null,
      capabilities: capabilities || [],
      skills: skills || [],
      knowledge: knowledge || [],
      isPublished: isPublished ?? true,
      creditBalance: creditBalance ?? 0,
      allowHiring: allowHiring ?? false,
      ...(systemPrompt && { systemPrompt }),
      ...(archetype && { archetype }),
      ...(archetypeConfig && { archetypeConfig }),
    });

    res.status(201).json({ agent });
  } catch (error: unknown) {
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
      'name', 'avatar', 'tagline',
      'description', 'category', 'tags', 'price', 'capabilities',
      'skills', 'knowledge',
      'isPublished', 'status', 'creditBalance', 'allowHiring',
      'systemPrompt', 'allowedModels', 'scheduleInterval',
      'archetype', 'archetypeConfig',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        agent.set(field, req.body[field]);
      }
    }

    await agent.save();

    // Auto-manage linked triggers for archetype agents (non-blocking, only when relevant fields change)
    if (req.body.archetype !== undefined || req.body.archetypeConfig !== undefined || req.body.scheduleInterval !== undefined || req.body.status !== undefined) {
      syncArchetypeTriggers(agent._id.toString(), agent.author.toString(), agent).catch(err => {
        log.agents.error({ err, agentId: agent._id }, 'Failed to sync archetype triggers');
      });
    }

    res.json({ agent });
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error deleting agent');
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
