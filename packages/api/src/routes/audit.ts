/**
 * Audit Routes — Export agent activity logs for compliance.
 *
 * Provides endpoints for organizations to export agent session events
 * in JSON or CSV format, with filtering by date range, agent, and event type.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { AgentSession } from '../models/agent-session.js';
import { EventStreamEntry } from '../models/event-stream-entry.js';
import { Agent } from '../models/agent.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// GET /audit/export — Export agent activity logs
router.get('/export', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const {
      agentId,
      from,
      to,
      type,
      format = 'json',
      limit = '1000',
    } = req.query;

    // Find sessions belonging to this user
    const sessionFilter: any = { userId: req.user.id };
    if (agentId && typeof agentId === 'string') {
      sessionFilter.agentId = agentId;
    }

    const sessions = await AgentSession.find(sessionFilter)
      .select('_id agentId task status stats')
      .lean();

    if (sessions.length === 0) {
      return res.json({ entries: [], total: 0 });
    }

    const sessionIds = sessions.map(s => s._id);
    const sessionMap = new Map(sessions.map(s => [s._id.toString(), s]));

    // Build event filter
    const eventFilter: any = { sessionId: { $in: sessionIds } };

    if (from || to) {
      eventFilter.timestamp = {};
      if (from) eventFilter.timestamp.$gte = new Date(from as string).getTime();
      if (to) eventFilter.timestamp.$lte = new Date(to as string).getTime();
    }

    if (type && typeof type === 'string') {
      eventFilter.type = { $in: type.split(',') };
    }

    const limitNum = Math.min(10000, Math.max(1, parseInt(limit as string, 10) || 1000));

    const entries = await EventStreamEntry
      .find(eventFilter)
      .sort({ timestamp: 1 })
      .limit(limitNum)
      .lean();

    const total = await EventStreamEntry.countDocuments(eventFilter);

    // Enrich with session info
    const enriched = entries.map(entry => {
      const session = sessionMap.get(entry.sessionId.toString());
      return {
        id: entry._id,
        sessionId: entry.sessionId,
        agentId: session?.agentId,
        task: session?.task,
        seq: entry.seq,
        timestamp: new Date(entry.timestamp).toISOString(),
        type: entry.type,
        content: entry.content,
        toolName: entry.metadata?.toolName,
        durationMs: entry.metadata?.durationMs,
        exitCode: entry.metadata?.exitCode,
      };
    });

    if (format === 'csv') {
      // Generate CSV
      const headers = ['id', 'sessionId', 'agentId', 'task', 'seq', 'timestamp', 'type', 'toolName', 'durationMs', 'content'] as const;
      const csvRows = [
        headers.join(','),
        ...enriched.map(e =>
          headers.map(h => {
            const val = e[h];
            if (val == null) return '';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
          }).join(',')
        ),
      ];

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="alia-audit-${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvRows.join('\n'));
    }

    // JSON response
    res.json({
      entries: enriched,
      total,
      exportedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error exporting audit logs');
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

// GET /audit/summary — High-level audit summary
router.get('/summary', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { from, to } = req.query;

    const sessionFilter: any = { userId: req.user.id };
    if (from || to) {
      sessionFilter.createdAt = {};
      if (from) sessionFilter.createdAt.$gte = new Date(from as string);
      if (to) sessionFilter.createdAt.$lte = new Date(to as string);
    }

    const sessions = await AgentSession.find(sessionFilter)
      .select('_id status stats agentId')
      .lean();

    const sessionIds = sessions.map(s => s._id);

    // Count events by type
    const typeCounts = await EventStreamEntry.aggregate([
      { $match: { sessionId: { $in: sessionIds } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);

    const typeMap = Object.fromEntries(typeCounts.map(t => [t._id, t.count]));

    res.json({
      totalSessions: sessions.length,
      completedSessions: sessions.filter(s => s.status === 'completed').length,
      failedSessions: sessions.filter(s => s.status === 'failed').length,
      totalSteps: sessions.reduce((sum, s) => sum + (s.stats?.totalSteps || 0), 0),
      totalTokens: sessions.reduce((sum, s) => sum + (s.stats?.totalTokens || 0), 0),
      eventsByType: typeMap,
      threatDetections: typeMap.threat_detected || 0,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error generating audit summary');
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// GET /audit/threats — Recent threat detections for settings threat log
router.get('/threats', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { limit = '20' } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));

    // Find user's sessions
    const sessions = await AgentSession.find({ userId: req.user.id })
      .select('_id agentId task')
      .lean();

    if (sessions.length === 0) {
      return res.json({ threats: [], total: 0 });
    }

    const sessionIds = sessions.map(s => s._id);
    const sessionMap = new Map(sessions.map(s => [s._id.toString(), s]));

    // Find threat/warning events
    const entries = await EventStreamEntry
      .find({
        sessionId: { $in: sessionIds },
        $or: [
          { type: 'threat_detected' },
          { type: 'system_message', content: { $regex: /THREAT/ } },
        ],
      })
      .sort({ timestamp: -1 })
      .limit(limitNum)
      .lean();

    const total = await EventStreamEntry.countDocuments({
      sessionId: { $in: sessionIds },
      $or: [
        { type: 'threat_detected' },
        { type: 'system_message', content: { $regex: /THREAT/ } },
      ],
    });

    // Look up agent names
    const agentIds = [...new Set(sessions.map(s => s.agentId?.toString()).filter(Boolean))];
    const agents = agentIds.length > 0
      ? await Agent.find({ _id: { $in: agentIds } }).select('name handle').lean()
      : [];
    const agentMap = new Map(agents.map(a => [a._id.toString(), a]));

    const threats = entries.map(entry => {
      const session = sessionMap.get(entry.sessionId.toString());
      const agent = session?.agentId ? agentMap.get(session.agentId.toString()) : undefined;
      const isBlocked = entry.content?.includes('BLOCKED');
      return {
        id: entry._id,
        timestamp: new Date(entry.timestamp).toISOString(),
        severity: isBlocked ? 'critical' : entry.content?.includes('WARNING') ? 'warning' : 'info',
        agentName: agent?.name || agent?.handle || 'Unknown',
        description: entry.content,
        sessionId: entry.sessionId,
        type: entry.type,
      };
    });

    res.json({ threats, total });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error fetching threat log');
    res.status(500).json({ error: 'Failed to fetch threat log' });
  }
});

export default router;
