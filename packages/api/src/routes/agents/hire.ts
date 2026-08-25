import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { authenticateToken } from '../../middleware/auth.js';
import { canReachAgent } from '../../lib/agent-account.js';
import { getAgentCapabilities } from '../../lib/agent/health.js';
import { startAgentSession } from '../../lib/agent/session-handoff.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

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

    const agent = await findAgentById(getDb(), String(req.params.id));
    /**
     * The same rule the thread applies, because hiring an agent IS using it —
     * this said `!agent.isPublished`, which was the second half of "published
     * means anyone may run it" and would now let a stranger run a private
     * agent that happens to be listed.
     *
     * A refusal is 404 rather than 403 for the reason it always is here: a 403
     * confirms the agent exists.
     */
    if (!agent || !(await canReachAgent(agent, {
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
    }))) {
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

    /**
     * Reserve, create, count and enqueue — as one operation that cannot leave
     * the reservation behind.
     *
     * This was four calls in this `try`, and the `catch` below answered a
     * failure of any of them with a 500 and a log line. `reserveCredits`
     * DEBITS, so those 500s each cost the caller the agent's price for an agent
     * that never ran. `startAgentSession` owns the undo; the two failures it
     * reports are the two answers this route has always had.
     */
    const handoff = await startAgentSession({ agent, userId: req.user.id, task, origin: 'hire' });

    if (!handoff.ok) {
      if (handoff.reason === 'insufficient_credits') {
        return res.status(402).json({
          error: 'Insufficient credits',
          creditsNeeded: handoff.creditsNeeded,
        });
      }
      return res.status(500).json({ error: 'Failed to hire agent' });
    }

    res.json({ sessionId: handoff.sessionId, hired: true, queued: handoff.queued, jobId: handoff.jobId });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error hiring agent');
    res.status(500).json({ error: 'Failed to hire agent' });
  }
});

export default router;
