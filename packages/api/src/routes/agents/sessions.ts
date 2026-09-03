import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { cleanupSessionResources } from '../../lib/agent/session-resources.js';
import { getJobStatus, cancelJob } from '../../lib/task-queue.js';
import { getDb } from '../../db/index.js';
import {
  updateAgent,
  withoutInternalAgentBindings,
} from '../../db/agents/agentRepository.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { resolveAgentIdentities, type AgentIdentity } from '../../lib/agent-identity.js';
import {
  findAgentSessionOwnedBy,
  listActiveAgentSessions,
  listAgentSessionHistory,
  listAgentSessionsForOwner,
  listChildAgentSessions,
  listUnfinishedAgentSessions,
  updateAgentSession,
  type AgentSessionAgentRef,
  type AgentSessionListing,
} from '../../db/agents/agentSessionRepository.js';
import { listRecentEventStreamEntries } from '../../db/agents/eventStreamEntryRepository.js';
import { AGENT_STATUSES, type AgentStatus } from '../../domain/agent.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/** An agent reference with its Oxy identity attached, as a task card renders it. */
type HydratedAgentRef = AgentSessionAgentRef & AgentIdentity;

/** A listing plus the agents its delegated children ran, as the task cards render it. */
interface SessionWithChildren extends Omit<AgentSessionListing, 'agentId'> {
  agentId: HydratedAgentRef | null;
  childAgents?: HydratedAgentRef[];
}

/**
 * Attach every agent identity a page needs in ONE Oxy call.
 *
 * A task listing names an agent twice — the session's own, and one per
 * delegated child — and both are bot accounts. Resolving them per row would be
 * one round trip per card; collecting every account id in the page first makes
 * it one for the page, which is the whole reason `resolveAgentIdentities`
 * returns a map instead of doing the attaching itself.
 */
function hydrateSessionAgents(
  sessions: readonly (AgentSessionListing & { childAgents?: AgentSessionAgentRef[] })[],
  identities: Map<string, AgentIdentity>,
): SessionWithChildren[] {
  // A session's embedded agent reference carries no author of its own — the
  // session belongs to the person who started it, not to whoever built the
  // agent — so `authorName` is null here whether Oxy resolved the account or not.
  const UNRESOLVED: AgentIdentity = { name: null, handle: null, color: null, authorName: null };
  const hydrate = (ref: AgentSessionAgentRef): HydratedAgentRef => ({
    ...ref,
    ...(identities.get(ref.oxyAccountId) ?? UNRESOLVED),
  });
  return sessions.map(({ childAgents, agentId, ...session }) => ({
    ...session,
    agentId: agentId === null ? null : hydrate(agentId),
    ...(childAgents !== undefined && { childAgents: childAgents.map(hydrate) }),
  }));
}

/** Every bot account a page of listings names, deduplicated by the resolver. */
async function withAgentIdentities(
  sessions: readonly (AgentSessionListing & { childAgents?: AgentSessionAgentRef[] })[],
): Promise<SessionWithChildren[]> {
  const accountIds = sessions.flatMap((session) => [
    ...(session.agentId === null ? [] : [session.agentId.oxyAccountId]),
    ...(session.childAgents ?? []).map((child) => child.oxyAccountId),
  ]);
  return hydrateSessionAgents(sessions, await resolveAgentIdentities(accountIds));
}

/**
 * Attach child agent info to a page of parent sessions, in ONE query.
 *
 * Returns a NEW array rather than mutating the argument in place, which is what
 * the Mongoose version did to `.lean()` documents. A mutation in place is
 * invisible at the call site and only worked because those objects were plain;
 * doing it here would mean writing an extra property onto a repository record
 * whose type does not have one.
 */
async function withChildAgents(
  sessions: AgentSessionListing[],
  oxyUserId: string,
): Promise<(AgentSessionListing & { childAgents?: AgentSessionAgentRef[] })[]> {
  if (sessions.length === 0) return [];
  const children = await listChildAgentSessions(
    getDb(),
    sessions.map((session) => session._id),
    oxyUserId,
  );
  if (children.length === 0) return sessions;

  const byParent = new Map<string, AgentSessionAgentRef[]>();
  for (const child of children) {
    const existing = byParent.get(child.parentSessionId);
    if (existing) existing.push(child.agent);
    else byParent.set(child.parentSessionId, [child.agent]);
  }

  return sessions.map((session) => {
    const childAgents = byParent.get(session._id);
    return childAgents === undefined ? session : { ...session, childAgents };
  });
}

// GET /agents/:id/sessions - list sessions for an agent
router.get('/:id/sessions', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const listing = await listAgentSessionsForOwner(
      getDb(),
      String(req.params.id),
      req.user.id,
      50,
    );

    res.json({ sessions: await withAgentIdentities(listing) });
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
    if (!isAgentStatus(status)) {
      return res.status(400).json({ error: 'status must be active, idle, or offline' });
    }

    const id = String(req.params.id);
    if (req.accessToken === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const loaded = await loadAgentForActor(getDb(), {
      agentId: id,
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
      // A WRITE — it patches `status` and cancels running sessions.
      cache: false,
    });
    if (!loaded.ok) {
      if (loaded.refusal === 'agent_not_found') {
        return res.status(404).json({ error: 'Agent not found' });
      }
      return res.status(refusalStatus(loaded.refusal)).json({
        error: refusalMessage(loaded.refusal),
      });
    }
    const agent = loaded.agent;
    if (typeof agent.applicationId === 'string') {
      return res.status(400).json({ error: 'Product-agent policy is managed internally' });
    }

    /**
     * The OPERATOR's availability toggle, through the ordinary patch — not
     * through `setAgentCatalogueFlags`, which is enforcement's narrow power and
     * answers to nobody's membership. The two must not become one function that
     * either caller can reach.
     */
    await updateAgent(getDb(), id, { status });

    // If setting to idle/offline, cancel running sessions
    if (status !== 'active') {
      const running = await listUnfinishedAgentSessions(getDb(), id);

      for (const session of running) {
        await cancelJob(session._id).catch(() => false);
        await cleanupSessionResources(session._id, session.oxyUserId);
        await updateAgentSession(getDb(), session._id, {
          status: 'cancelled',
          stats: { completedAt: new Date() },
        });
      }
    }

    res.json({
      agent: withoutInternalAgentBindings({ ...agent, status }),
      cancelledSessions: status !== 'active',
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error updating agent status');
    res.status(500).json({ error: 'Failed to update status' });
  }
});

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);
}

// POST /agents/:id/sessions/:sid/cancel - cancel a session
router.post('/:id/sessions/:sid/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sessionId = String(req.params.sid);
    const session = await findAgentSessionOwnedBy(getDb(), sessionId, req.user.id);

    if (!session || session.agentId !== String(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'running' && session.status !== 'queued') {
      return res.status(400).json({ error: 'Session is not running' });
    }

    await cancelJob(sessionId).catch(() => false);
    await cleanupSessionResources(sessionId, session.oxyUserId);
    await updateAgentSession(getDb(), sessionId, {
      status: 'cancelled',
      stats: { completedAt: new Date() },
    });

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

    const sessionId = String(req.params.sid);
    const session = await findAgentSessionOwnedBy(getDb(), sessionId, req.user.id);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get recent events from the separate collection
    const recentEvents = await listRecentEventStreamEntries(getDb(), sessionId, 30);

    // Get job queue status (if Redis is available)
    const jobStatus = await getJobStatus(sessionId);

    /**
     * `eventStream` and `messages` are dropped, which is what the projection
     * did. Both are `jsonb` that grows all run — the event stream is the largest
     * column in the table — and this endpoint is polled every five seconds by
     * the agent panel.
     */
    const { eventStream: _eventStream, messages: _messages, ...visible } = session;

    res.json({
      session: visible,
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

    const listing = await listActiveAgentSessions(getDb(), req.user.id, 20);
    const sessions = await withAgentIdentities(await withChildAgents(listing, req.user.id));

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

    const { sessions: listing, total } = await listAgentSessionHistory(getDb(), req.user.id, {
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
    });
    const sessions = await withAgentIdentities(await withChildAgents(listing, req.user.id));

    res.json({ sessions, total, page: pageNum, limit: limitNum });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing session history');
    res.status(500).json({ error: 'Failed to list session history' });
  }
});

export default router;
