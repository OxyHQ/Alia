import { Router } from 'express';
import { Agent } from '../../models/agent.js';
import { AgentSession } from '../../models/agent-session.js';
import { Conversation } from '../../models/conversation.js';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getRecentActivity } from '../../lib/agent-runner.js';
import { EventStreamEntry as EventStreamEntryModel } from '../../models/event-stream-entry.js';
import { Trigger } from '../../models/trigger.js';
import { TriggerExecution } from '../../models/trigger-execution.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting activity grid');
    res.status(500).json({ error: 'Failed to get activity grid' });
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

    const filter: Record<string, unknown> = { sessionId };
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting session activity');
    res.status(500).json({ error: 'Failed to get activity' });
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting session sources');
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing agent reports');
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

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

    const { RoutingLog } = await import('../../models/routing-log.js');

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
  } catch (error: unknown) {
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

    const { RoutingLog } = await import('../../models/routing-log.js');
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting routing stats');
    res.status(500).json({ error: 'Failed to get routing stats' });
  }
});

export default router;
