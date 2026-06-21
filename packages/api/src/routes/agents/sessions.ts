import { Router } from 'express';
import { Agent } from '../../models/agent.js';
import { AgentSession } from '../../models/agent-session.js';
import { authenticateToken } from '../../middleware/auth.js';
import { cleanupSessionResources } from '../../lib/agent-tools.js';
import { getJobStatus, cancelJob } from '../../lib/task-queue.js';
import { EventStreamEntry as EventStreamEntryModel } from '../../models/event-stream-entry.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/** Batch-attach child agent info to parent sessions (for delegation display). Mutates in place. */
async function attachChildAgents(sessions: Record<string, any>[], userId: string): Promise<void> {
  const sessionIds = sessions.map(s => s._id);
  if (sessionIds.length === 0) return;

  const childSessions = await AgentSession.find({
    parentSessionId: { $in: sessionIds },
    userId,
  })
    .populate('agentId', 'name handle avatar')
    .select('agentId parentSessionId')
    .lean();

  const childMap = new Map<string, typeof childSessions>();
  for (const child of childSessions) {
    if (!child.parentSessionId || !child.agentId) continue;
    const key = child.parentSessionId.toString();
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(child);
  }

  for (const session of sessions) {
    const children = childMap.get(session._id.toString());
    if (children?.length) {
      session.childAgents = children.map(c => c.agentId);
    }
  }
}

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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting session status');
    res.status(500).json({ error: 'Failed to get session status' });
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

    await attachChildAgents(sessions, req.user.id);

    res.json({ sessions });
  } catch (error: unknown) {
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

    await attachChildAgents(sessions, req.user.id);

    res.json({ sessions, total, page: pageNum, limit: limitNum });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing session history');
    res.status(500).json({ error: 'Failed to list session history' });
  }
});

export default router;
