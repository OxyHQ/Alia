/**
 * Audit Routes — Export agent activity logs for compliance.
 *
 * Provides endpoints for organizations to export agent session events
 * in JSON or CSV format, with filtering by date range, agent, and event type.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { findAgentsByIds } from '../db/agents/agentRepository.js';
import {
  listAgentSessionsForAudit,
  type AuditSessionRef,
} from '../db/agents/agentSessionRepository.js';
import {
  countEventStreamEntriesByType,
  listAuditEventStreamEntries,
  listThreatEventStreamEntries,
} from '../db/agents/eventStreamEntryRepository.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/** A `Date` from a query parameter, or nothing — never an Invalid Date. */
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value);
  /**
   * An unparseable date used to reach the filter as `NaN`, which Mongo compared
   * against and matched nothing. Against a `bigint` column it is a driver
   * serialisation error instead — a 500 on a typo'd query string — so it is
   * rejected here and the window simply stays open on that side.
   */
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

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
    const sessions = await listAgentSessionsForAudit(getDb(), req.user.id, {
      ...(typeof agentId === 'string' && agentId !== '' && { agentId }),
    });

    if (sessions.length === 0) {
      return res.json({ entries: [], total: 0 });
    }

    const sessionMap = new Map<string, AuditSessionRef>(sessions.map((s) => [s._id, s]));
    const limitNum = Math.min(10000, Math.max(1, parseInt(limit as string, 10) || 1000));

    const { entries, total } = await listAuditEventStreamEntries(getDb(), [...sessionMap.keys()], {
      ...(parseDate(from) !== undefined && { from: parseDate(from) }),
      ...(parseDate(to) !== undefined && { to: parseDate(to) }),
      ...(typeof type === 'string' && type !== '' && { types: type.split(',') }),
      limit: limitNum,
    });

    // Enrich with session info
    const enriched = entries.map(entry => {
      const session = sessionMap.get(entry.sessionId);
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

    const sessions = await listAgentSessionsForAudit(getDb(), req.user.id, {
      ...(parseDate(from) !== undefined && { from: parseDate(from) }),
      ...(parseDate(to) !== undefined && { to: parseDate(to) }),
    });

    // Count events by type
    const typeCounts = await countEventStreamEntriesByType(
      getDb(),
      sessions.map((s) => s._id),
    );

    const typeMap = Object.fromEntries(typeCounts.map(t => [t.type, t.count]));

    res.json({
      totalSessions: sessions.length,
      completedSessions: sessions.filter(s => s.status === 'completed').length,
      failedSessions: sessions.filter(s => s.status === 'failed').length,
      totalSteps: sessions.reduce((sum, s) => sum + s.stats.totalSteps, 0),
      totalTokens: sessions.reduce((sum, s) => sum + s.stats.totalTokens, 0),
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
    const sessions = await listAgentSessionsForAudit(getDb(), req.user.id, {});

    if (sessions.length === 0) {
      return res.json({ threats: [], total: 0 });
    }

    const sessionMap = new Map<string, AuditSessionRef>(sessions.map((s) => [s._id, s]));

    const { entries, total } = await listThreatEventStreamEntries(
      getDb(),
      [...sessionMap.keys()],
      limitNum,
    );

    // Look up agent names
    const agentIds = [...new Set(sessions.map(s => s.agentId))];
    const agents = await findAgentsByIds(getDb(), agentIds);
    const agentMap = new Map(agents.map(a => [a._id, a]));

    const threats = entries.map(entry => {
      const session = sessionMap.get(entry.sessionId);
      const agent = session ? agentMap.get(session.agentId) : undefined;
      const isBlocked = entry.content.includes('BLOCKED');
      return {
        id: entry._id,
        timestamp: new Date(entry.timestamp).toISOString(),
        severity: isBlocked ? 'critical' : entry.content.includes('WARNING') ? 'warning' : 'info',
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
