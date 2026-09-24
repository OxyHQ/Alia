import { Router } from 'express';
import { countConversationsPerDayForAgent } from '../../db/chat/conversationRepository.js';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getRecentActivity } from '../../lib/agent/runner.js';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  countAgentSessionsByDay,
  findAgentSessionOwnedBy,
  findLatestAgentSessionOwnedBy,
} from '../../db/agents/agentSessionRepository.js';
import {
  listSessionActivity,
  listSessionEntriesOfType,
} from '../../db/agents/eventStreamEntryRepository.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// GET /agents/:id/activity - get recent activity buffer
router.get('/:id/activity', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await findAgentById(getDb(), String(req.params.id));
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    /**
     * The most recent running or completed session THIS CALLER has with the
     * agent.
     *
     * It used to be the most recent session of the agent, across every user,
     * behind `optionalAuth` — so for a published agent, which many people run,
     * an unauthenticated `GET /agents/<id>/activity` returned whoever ran it
     * last: their tool calls, tool results, file changes and screenshots, by
     * way of `getRecentActivity`.
     *
     * The socket serving the same data has always gated it
     * (`socket.ts`, `subscribe-agent`: `account:act_as` on the bot account, or
     * an owned session). This is the HTTP half of that rule, in the narrow
     * form: your own sessions. An operator watching an agent's live work uses
     * that room, or `/:id/sessions/:sessionId/activity` beside this route,
     * which has always been `authenticateToken` + `findAgentSessionOwnedBy`.
     *
     * Anonymous callers get an empty buffer rather than a 401: the published
     * agent profile is readable without signing in, and it has no activity of
     * its own to show a visitor.
     */
    const viewerId = req.user?.id;
    if (!viewerId) {
      return res.json({ activity: [] });
    }

    const latestSession = await findLatestAgentSessionOwnedBy(getDb(), agent._id, viewerId, [
      'running',
      'completed',
    ]);

    if (!latestSession) {
      return res.json({ activity: [] });
    }

    const activity = await getRecentActivity(latestSession._id);
    res.json({ activity });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting agent activity');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// GET /agents/:id/activity-grid - aggregated session counts by day for heatmap
router.get('/:id/activity-grid', optionalAuth, async (req: Request, res: Response) => {
  try {
    const agent = await findAgentById(getDb(), String(req.params.id));
    if (!agent || !agent.isPublished) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks as string, 10) || 52));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - weeks * 7);

    /**
     * The two halves now come from different stores, and they must agree on what
     * a "day" is. `$dateToString` with no timezone renders UTC, so the Postgres
     * side renders UTC explicitly — `to_char` on a `timestamptz` would otherwise
     * follow the session's `TimeZone` and bucket the same instant into a
     * different day from the Mongo half, which reads as a plausible heatmap.
     */
    const [sessionResult, conversationResult] = await Promise.all([
      countAgentSessionsByDay(getDb(), agent._id, startDate),
      countConversationsPerDayForAgent(getDb(), agent._id, startDate),
    ]);

    const countMap = new Map<string, number>();
    for (const r of sessionResult) countMap.set(r.date, (countMap.get(r.date) || 0) + r.count);
    for (const r of conversationResult) countMap.set(r.day, (countMap.get(r.day) || 0) + r.count);

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

    /**
     * Ownership in the WHERE, not a comparison after the read.
     *
     * The source loaded the session by id and then compared `userId`, which
     * answers 403 rather than 404 — so a stranger learned that a session id
     * exists. It also put the check one edit away from being dropped. Not
     * finding it and not owning it are now the same answer.
     */
    const session = await findAgentSessionOwnedBy(getDb(), String(sessionId), req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string, 10) || 200));
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    const { entries, total } = await listSessionActivity(getDb(), String(sessionId), {
      ...(typeof type === 'string' && { type }),
      limit: limitNum,
      offset: offsetNum,
    });

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

    const sessionId = String(req.params.sid);
    const session = await findAgentSessionOwnedBy(getDb(), sessionId, req.user.id);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Query event stream for source_found events
    const sourceEvents = await listSessionEntriesOfType(getDb(), sessionId, 'source_found');

    const sources = sourceEvents.map((entry) => ({
      url: entry.metadata?.url ?? '',
      title: entry.metadata?.title ?? '',
      domain: entry.metadata?.domain ?? '',
      snippet: entry.content.slice(0, 200),
      timestamp: entry.timestamp,
    }));

    res.json({ sources });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting session sources');
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

export default router;
