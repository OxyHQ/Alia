import { Router } from 'express';
import { generateText } from 'ai';
import { Agent } from '../models/agent.js';
import { AgentSession } from '../models/agent-session.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { runAgentSession, getRecentActivity } from '../lib/agent-runner.js';
import { cleanupSessionResources } from '../lib/agent-tools.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
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

// POST /agents/generate - AI generates agent config from natural language prompt
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'A prompt of at least 10 characters is required' });
    }

    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      return res.status(503).json({ error: 'No AI models available' });
    }

    const model = getAIModel(resolved.keyConfig);

    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: `You are an agent configuration generator. Given a user's description of what they want their AI agent to do, generate a structured JSON configuration for the agent.

Return ONLY valid JSON with these fields:
- "name": A short, memorable name for the agent (2-4 words max)
- "tagline": A one-sentence description (under 100 chars)
- "description": A detailed description of the agent's purpose and behavior (2-3 sentences)
- "systemPrompt": Detailed instructions for the agent including its role, goals, behavior guidelines, and how it should interact with users. This should be comprehensive and specific.
- "category": Exactly one of: "Assistant", "Creative", "Developer", "Research", "Business", "Education"
- "tags": An array of 3-5 relevant lowercase tags
- "capabilities": An array of 3-5 specific things this agent can do (short phrases)

Do not include any text outside the JSON object.`,
        },
        {
          role: 'user',
          content: prompt.trim(),
        },
      ],
      temperature: 0.7,
      maxRetries: 0,
    });

    const responseText = result.text || '';

    // Parse JSON from the response (handle potential markdown code blocks)
    let parsed: any;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      log.agents.error({ responseText }, 'Failed to parse AI-generated agent config');
      return res.status(500).json({ error: 'Failed to generate agent configuration' });
    }

    // Generate handle from name
    const baseName = (parsed.name || 'agent').trim();
    let handle = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    // Check handle uniqueness, append suffix if needed
    const existing = await Agent.findOne({ handle });
    if (existing) {
      handle = `${handle}-${Date.now().toString(36).slice(-4)}`;
    }

    res.json({
      name: parsed.name || 'New Agent',
      handle,
      tagline: parsed.tagline || '',
      description: parsed.description || '',
      systemPrompt: parsed.systemPrompt || '',
      category: ['Assistant', 'Creative', 'Developer', 'Research', 'Business', 'Education'].includes(parsed.category)
        ? parsed.category
        : 'Assistant',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.slice(0, 10) : [],
    });
  } catch (error) {
    log.agents.error({ err: error }, 'Error generating agent config');
    res.status(500).json({ error: 'Failed to generate agent configuration' });
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

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow owner to view unpublished (draft) agents
    if (!agent.isPublished && (!req.user?.id || agent.author.toString() !== req.user.id)) {
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
      name, handle, avatar,
      tagline, description, category, tags, price,
      capabilities, isPublished, creditBalance, allowHiring,
      systemPrompt,
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
      isPublished: isPublished ?? true,
      creditBalance: creditBalance ?? 0,
      allowHiring: allowHiring ?? false,
      ...(systemPrompt && { systemPrompt }),
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
      'name', 'avatar', 'tagline',
      'description', 'category', 'tags', 'price', 'capabilities',
      'isPublished', 'status', 'creditBalance', 'allowHiring',
      'systemPrompt', 'allowedModels', 'scheduleInterval',
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

// POST /agents/:id/hire - hire agent with a task
router.post('/:id/hire', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { task } = req.body;
    if (!task || typeof task !== 'string') {
      return res.status(400).json({ error: 'task is required' });
    }

    const agent = await Agent.findById(req.params.id);
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (agent.status !== 'active') {
      return res.status(400).json({ error: 'Agent is not currently active' });
    }

    // Create session
    const session = await AgentSession.create({
      agentId: agent._id,
      userId: req.user.id,
      task,
      status: 'queued',
      depth: 0,
    });

    // Increment counters
    agent.hireCount += 1;
    agent.usageCount += 1;
    await agent.save();

    // Start runner in background (fire-and-forget)
    runAgentSession(session._id.toString()).catch(err => {
      log.agents.error({ err, sessionId: session._id }, 'Agent session runner failed');
    });

    res.json({ sessionId: session._id, hired: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error hiring agent');
    res.status(500).json({ error: 'Failed to hire agent' });
  }
});

// GET /agents/:id/activity - get recent activity buffer
router.get('/:id/activity', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const activity = getRecentActivity(agent._id.toString());
    res.json({ activity });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting agent activity');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// GET /agents/:id/sessions - list sessions for an agent
router.get('/:id/sessions', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sessions = await AgentSession.find({
      agentId: req.params.id,
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('status task result stats config createdAt')
      .lean();

    res.json({ sessions });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing sessions');
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// PATCH /agents/:id/status - owner toggle status
router.patch('/:id/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { status } = req.body;
    if (!status || !['active', 'idle', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, idle, or offline' });
    }

    const agent = await Agent.findOne({
      _id: req.params.id,
      author: req.user.id,
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not owned by you' });
    }

    agent.status = status;
    await agent.save();

    // If setting to idle/offline, cancel running sessions
    if (status !== 'active') {
      const runningSessions = await AgentSession.find({
        agentId: agent._id,
        status: { $in: ['queued', 'running'] },
      });

      for (const session of runningSessions) {
        session.status = 'cancelled';
        session.stats.completedAt = new Date();
        await cleanupSessionResources(session);
        await session.save();
      }
    }

    res.json({ agent, cancelledSessions: status !== 'active' ? true : false });
  } catch (error) {
    log.agents.error({ err: error }, 'Error updating agent status');
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /agents/:id/sessions/:sid/cancel - cancel a session
router.post('/:id/sessions/:sid/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      agentId: req.params.id,
      userId: req.user.id,
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'running' && session.status !== 'queued') {
      return res.status(400).json({ error: 'Session is not running' });
    }

    session.status = 'cancelled';
    session.stats.completedAt = new Date();
    await cleanupSessionResources(session);
    await session.save();

    res.json({ cancelled: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error cancelling session');
    res.status(500).json({ error: 'Failed to cancel session' });
  }
});

export default router;
