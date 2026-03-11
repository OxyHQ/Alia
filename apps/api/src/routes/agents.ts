import { Router } from 'express';
import { generateText } from 'ai';
import { Agent, AGENT_ARCHETYPES, type IAgent } from '../models/agent.js';
import { AgentSession } from '../models/agent-session.js';
import { AgentReview } from '../models/agent-review.js';
import { Conversation } from '../models/conversation.js';
import { Container } from '../models/container.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { getRecentActivity } from '../lib/agent-runner.js';
import { cleanupSessionResources } from '../lib/agent-tools.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { enqueueAgentSession, getJobStatus, cancelJob } from '../lib/task-queue.js';
import { reserveCredits } from '../lib/credits-manager.js';
import { EventStreamEntry as EventStreamEntryModel } from '../models/event-stream-entry.js';
import { getAgentCapabilities } from '../lib/agent/health.js';
import { Trigger } from '../models/trigger.js';
import { reloadTrigger, generateWebhookToken } from '../lib/trigger-engine.js';
import { TriggerExecution } from '../models/trigger-execution.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

type SessionResourceLike = {
  type: string;
  resourceId: string;
  status: string;
};

function resolveWorkspaceFilePath(inputPath: string): string | null {
  let normalized = inputPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) return null;

  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  } else if (normalized === 'workspace') {
    return null;
  }

  const safeSegments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    safeSegments.push(segment);
  }

  if (safeSegments.length === 0) return null;
  return `/workspace/${safeSegments.join('/')}`;
}

function safeDownloadName(filePath: string): string {
  const fileName = filePath.split('/').pop() || 'download.txt';
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function resolveSessionContainerId(
  sessionId: string,
  userId: string,
  resources: SessionResourceLike[] | undefined,
): Promise<string | null> {
  const resourceContainer = resources?.find(
    r => r.type === 'container' && (r.status === 'active' || r.status === 'idle'),
  );
  if (resourceContainer?.resourceId) return resourceContainer.resourceId;

  const containerDoc = await Container.findOne({
    sessionId: sessionId as any,
    userId: userId as any,
    status: { $in: ['running', 'idle'] },
  }).sort({ createdAt: -1 }).lean();

  return containerDoc?.containerId || null;
}

// GET /agents - list published agents (public, optional auth)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { category, search, featured, trending, page = '1', limit = '50' } = req.query;

    const filter: any = { isPublished: true };

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

    // Provider fallback retry loop (mirrors v1/chat-completions pattern)
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();
    let result: Awaited<ReturnType<typeof generateText>> | null = null;

    for (let attempt = 0; attempt < MAX_PROVIDER_RETRIES; attempt++) {
      const resolved = await resolveModel(getDefaultAliaModel(), skipProviders);
      if (!resolved) {
        if (attempt === 0) {
          return res.status(503).json({ error: 'No AI models available' });
        }
        break;
      }

      try {
        const model = getAIModel(resolved.keyConfig);
        result = await generateText({
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
- "capabilities": An array of tool IDs this agent should have enabled. Choose from: "web-browsing", "code-execution", "web-search", "web-scraping", "file-management", "image-generation", "memory", "agent-delegation". Pick only the ones relevant to the agent's purpose.
- "archetype": Exactly one of: "general", "qa", "task_router", "status_update". Use "qa" if the agent answers questions from knowledge/data sources. Use "task_router" if the agent triages and routes tasks to people or teams. Use "status_update" if the agent gathers data and generates periodic reports or summaries. Use "general" for everything else.

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
        break; // Success — exit retry loop
      } catch (providerError: any) {
        log.agents.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for agent generation');
        skipProviders.add(resolved.provider);
        if (attempt >= MAX_PROVIDER_RETRIES - 1) throw providerError;
      }
    }

    if (!result) {
      return res.status(503).json({ error: 'No AI models available' });
    }

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

    const validArchetypes = AGENT_ARCHETYPES;
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
      archetype: validArchetypes.includes(parsed.archetype) ? parsed.archetype : 'general',
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
      .populate('skills', 'skillId title icon color')
      .populate('knowledge', 'name type category url')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ agents });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing user agents');
    res.status(500).json({ error: 'Failed to list your agents' });
  }
});

// GET /agents/health - infrastructure status
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const capabilities = await getAgentCapabilities();
    res.json({ capabilities });
  } catch (error) {
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
      'skills', 'knowledge',
      'isPublished', 'status', 'creditBalance', 'allowHiring',
      'systemPrompt', 'allowedModels', 'scheduleInterval',
      'archetype', 'archetypeConfig', 'accessories',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (agent as any)[field] = req.body[field];
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

    // Check infrastructure capabilities
    const capabilities = await getAgentCapabilities();
    if (!capabilities.shell && !capabilities.browser) {
      return res.status(503).json({
        error: 'Agent execution infrastructure unavailable',
        capabilities,
      });
    }

    // Reserve credits (Manus-style: token + VM resource based)
    const baseCredits = agent.price || 15;
    const creditReservation = await reserveCredits(req.user.id, baseCredits);
    if (!creditReservation) {
      return res.status(402).json({
        error: 'Insufficient credits',
        creditsNeeded: baseCredits,
      });
    }

    // Create session with credit reservation
    const session = await AgentSession.create({
      agentId: agent._id,
      userId: req.user.id,
      task,
      status: 'queued',
      depth: 0,
      creditReservation,
    });

    // Increment counters
    agent.hireCount += 1;
    agent.usageCount += 1;
    await agent.save();

    // Enqueue via BullMQ (falls back to direct execution if Redis unavailable)
    const { queued, jobId } = await enqueueAgentSession({
      sessionId: session._id.toString(),
      userId: req.user.id,
      agentId: agent._id.toString(),
      agentName: agent.name,
    });

    res.json({ sessionId: session._id, hired: true, queued, jobId });
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

    // Find the most recent running or completed session for this agent
    const latestSession = await AgentSession.findOne(
      { agentId: agent._id, status: { $in: ['running', 'completed'] } },
      { _id: 1 },
      { sort: { createdAt: -1 } },
    );

    if (!latestSession) {
      return res.json({ activity: [] });
    }

    const activity = await getRecentActivity(latestSession._id.toString());
    res.json({ activity });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting agent activity');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// GET /agents/:id/activity-grid - aggregated session counts by day for heatmap
router.get('/:id/activity-grid', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks as string, 10) || 52));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - weeks * 7);

    const [sessionResult, conversationResult] = await Promise.all([
      AgentSession.aggregate([
        { $match: { agentId: agent._id, createdAt: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Conversation.aggregate([
        { $match: { agentId: agent._id, createdAt: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
    ]);

    const countMap = new Map<string, number>();
    for (const r of sessionResult) countMap.set(r._id, (countMap.get(r._id) || 0) + r.count);
    for (const r of conversationResult) countMap.set(r._id, (countMap.get(r._id) || 0) + r.count);

    const grid = Array.from(countMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
    const totalSessions = grid.reduce((s, d) => s + d.count, 0);
    const maxCount = grid.reduce((m, d) => Math.max(m, d.count), 0);

    res.json({ grid, totalSessions, maxCount });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting activity grid');
    res.status(500).json({ error: 'Failed to get activity grid' });
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
        await cancelJob(session._id.toString()).catch(() => false);
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

    await cancelJob(session._id.toString()).catch(() => false);
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

// GET /agents/sessions/:sid/status - get session status, plan, recent events
router.get('/sessions/:sid/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    })
      .select('agentId status task result plan stats config depth createdAt updatedAt')
      .populate('agentId', 'name handle avatar')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get recent events from the separate collection
    const recentEvents = await EventStreamEntryModel
      .find({ sessionId: req.params.sid })
      .sort({ seq: -1 })
      .limit(30)
      .lean();

    // Get job queue status (if Redis is available)
    const jobStatus = await getJobStatus(String(req.params.sid));

    res.json({
      session,
      recentEvents: recentEvents.reverse(),
      jobStatus,
    });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting session status');
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

// GET /agents/sessions/:sid/files - list workspace files
router.get('/sessions/:sid/files', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    })
      .select('resources')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const containerId = await resolveSessionContainerId(
      String(req.params.sid),
      String(req.user.id),
      session.resources as SessionResourceLike[] | undefined,
    );

    if (!containerId) {
      return res.json({ files: [], message: 'No workspace container found' });
    }

    // List files via Docker host
    const dockerHostUrl = process.env.DOCKER_HOST_URL;
    const dockerHostSecret = process.env.DOCKER_HOST_SECRET;
    if (!dockerHostUrl || !dockerHostSecret) {
      return res.json({ files: [], message: 'Docker host not configured' });
    }

    const listRes = await fetch(`${dockerHostUrl}/containers/${containerId}/files/list?dir=${encodeURIComponent('/workspace')}`, {
      headers: { Authorization: `Bearer ${dockerHostSecret}` },
    });

    if (!listRes.ok) {
      return res.json({ files: [], message: 'Failed to list workspace files' });
    }

    const data = await listRes.json();
    res.json({ files: data.files || [], containerId });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing session files');
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// GET /agents/sessions/:sid/files/* - download a file from workspace
router.get('/sessions/:sid/files/*', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Extract file path from wildcard
    const filePath = req.params[0];
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    })
      .select('resources')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const containerId = await resolveSessionContainerId(
      String(req.params.sid),
      String(req.user.id),
      session.resources as SessionResourceLike[] | undefined,
    );

    if (!containerId) {
      return res.status(404).json({ error: 'No workspace container found' });
    }

    const dockerHostUrl = process.env.DOCKER_HOST_URL;
    const dockerHostSecret = process.env.DOCKER_HOST_SECRET;
    if (!dockerHostUrl || !dockerHostSecret) {
      return res.status(503).json({ error: 'Docker host not configured' });
    }

    const absolutePath = resolveWorkspaceFilePath(filePath);
    if (!absolutePath) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    const fileRes = await fetch(
      `${dockerHostUrl}/containers/${containerId}/files/download?path=${encodeURIComponent(absolutePath)}`,
      { headers: { Authorization: `Bearer ${dockerHostSecret}` } },
    );

    if (!fileRes.ok) {
      let message = 'Failed to download file';
      try {
        const errPayload = await fileRes.json();
        if (typeof errPayload?.error === 'string' && errPayload.error.trim()) {
          message = errPayload.error.slice(0, 200);
        }
      } catch {
        // Keep generic message if docker host response is not JSON.
      }
      return res.status(fileRes.status).json({ error: message });
    }

    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(filePath)}"`);
    res.send(buffer);
  } catch (error) {
    log.agents.error({ err: error }, 'Error downloading session file');
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// GET /agents/sessions/active - list all active sessions for the current user
router.get('/sessions/active', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sessions = await AgentSession.find({
      userId: req.user.id,
      status: { $in: ['queued', 'running'] },
    })
      .populate('agentId', 'name handle avatar')
      .sort({ createdAt: -1 })
      .limit(20)
      .select('agentId status task plan stats createdAt')
      .lean();

    res.json({ sessions });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing active sessions');
    res.status(500).json({ error: 'Failed to list active sessions' });
  }
});

// GET /agents/sessions/history - list completed/failed sessions for the current user
router.get('/sessions/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 20));

    const [sessions, total] = await Promise.all([
      AgentSession.find({
        userId: req.user.id,
        status: { $in: ['completed', 'failed', 'cancelled'] },
      })
        .populate('agentId', 'name handle avatar')
        .sort({ 'stats.completedAt': -1, createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .select('agentId status task result plan stats createdAt')
        .lean(),
      AgentSession.countDocuments({
        userId: req.user.id,
        status: { $in: ['completed', 'failed', 'cancelled'] },
      }),
    ]);

    res.json({ sessions, total, page: pageNum, limit: limitNum });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing session history');
    res.status(500).json({ error: 'Failed to list session history' });
  }
});

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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    log.agents.error({ err: error }, 'Error deleting review');
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// GET /agents/sessions/:sid/sources - get sources found during a session
router.get('/sessions/:sid/sources', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    }).select('_id').lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Query event stream for source_found events
    const sourceEvents = await EventStreamEntryModel
      .find({ sessionId: req.params.sid, type: 'source_found' })
      .sort({ seq: 1 })
      .lean();

    const sources = sourceEvents.map((entry: any) => ({
      url: entry.metadata?.url || '',
      title: entry.metadata?.title || '',
      domain: entry.metadata?.domain || '',
      snippet: entry.content?.slice(0, 200) || '',
      timestamp: entry.timestamp,
    }));

    res.json({ sources });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting session sources');
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

// GET /agents/:id/sessions/:sessionId/activity — Agent session activity timeline
router.get('/:id/sessions/:sessionId/activity', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { sessionId } = req.params;
    const { type, limit = '200', offset = '0' } = req.query;

    // Verify session belongs to user
    const session = await AgentSession.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const filter: any = { sessionId };
    if (type && typeof type === 'string') {
      filter.type = type;
    }

    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string, 10) || 200));
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    const [entries, total] = await Promise.all([
      EventStreamEntryModel
        .find(filter)
        .sort({ seq: 1 })
        .skip(offsetNum)
        .limit(limitNum)
        .lean(),
      EventStreamEntryModel.countDocuments(filter),
    ]);

    res.json({
      entries,
      total,
      session: {
        status: session.status,
        task: session.task,
        result: session.result,
        stats: session.stats,
        config: session.config,
      },
    });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting session activity');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

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

// ── Reports Endpoint ────────────────────────────────────────────────

// GET /agents/:id/reports - list report executions for a status_update agent
router.get('/:id/reports', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findById(req.params.id).select('author archetype').lean();
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.author.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Find the trigger linked to this agent
    const trigger = await Trigger.findOne({
      'action.agentId': req.params.id,
      type: 'schedule',
      oxyUserId: req.user.id,
    }).select('_id').lean();

    if (!trigger) {
      return res.json({ reports: [], total: 0 });
    }

    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 20));

    const [reports, total] = await Promise.all([
      TriggerExecution.find({ triggerId: trigger._id })
        .sort({ startedAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .select('status result toolCalls tokens durationMs startedAt completedAt')
        .lean(),
      TriggerExecution.countDocuments({ triggerId: trigger._id }),
    ]);

    res.json({ reports, total, page: pageNum, limit: limitNum });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing agent reports');
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// ── Routing Logs Endpoint ───────────────────────────────────────────

// GET /agents/:id/routing-logs - list routing decisions for a task_router agent
router.get('/:id/routing-logs', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findById(req.params.id).select('author archetype').lean();
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.author.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { RoutingLog } = await import('../models/routing-log.js');

    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 20));

    const [logs, total] = await Promise.all([
      RoutingLog.find({ agentId: req.params.id })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      RoutingLog.countDocuments({ agentId: req.params.id }),
    ]);

    res.json({ logs, total, page: pageNum, limit: limitNum });
  } catch (error) {
    log.agents.error({ err: error }, 'Error listing routing logs');
    res.status(500).json({ error: 'Failed to list routing logs' });
  }
});

// GET /agents/:id/routing-stats - aggregate routing stats for a task_router agent
router.get('/:id/routing-stats', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const agent = await Agent.findById(req.params.id).select('author archetype').lean();
    if (!agent || agent.author.toString() !== req.user.id) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { RoutingLog } = await import('../models/routing-log.js');
    const agentObjectId = agent._id;

    const [result] = await RoutingLog.aggregate([
      { $match: { agentId: agentObjectId } },
      { $facet: {
        byCategory: [
          { $group: { _id: '$classification.category', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        byPriority: [
          { $group: { _id: '$classification.priority', count: { $sum: 1 } } },
        ],
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ],
        total: [{ $count: 'count' }],
      }},
    ]);

    const { byCategory = [], byPriority = [], byStatus = [], total: totalArr = [] } = result || {};
    res.json({ byCategory, byPriority, byStatus, total: totalArr[0]?.count || 0 });
  } catch (error) {
    log.agents.error({ err: error }, 'Error getting routing stats');
    res.status(500).json({ error: 'Failed to get routing stats' });
  }
});

export default router;
