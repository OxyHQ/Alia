import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { findAgentById, incrementAgentCounters } from '../../db/agents/agentRepository.js';
import { createAgentSession } from '../../db/agents/agentSessionRepository.js';
import { authenticateToken } from '../../middleware/auth.js';
import { getAgentCapabilities } from '../../lib/agent/health.js';
import { enqueueAgentSession } from '../../lib/task-queue.js';
import { reserveCredits } from '../../lib/credits-manager.js';
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
    const session = await createAgentSession(getDb(), {
      agentId: agent._id,
      oxyUserId: req.user.id,
      task,
      status: 'queued',
      depth: 0,
      creditReservation,
    });

    /**
     * One statement, not a read-modify-write.
     *
     * `agent.hireCount += 1; await agent.save()` lost a concurrent hire: two
     * requests read the same value and wrote the same value+1. `$inc` did not,
     * and neither does this.
     */
    await incrementAgentCounters(getDb(), agent._id, { hireCount: 1, usageCount: 1 });

    // Enqueue via BullMQ (falls back to direct execution if Redis unavailable)
    const { queued, jobId } = await enqueueAgentSession({
      sessionId: session._id,
      userId: req.user.id,
      agentId: agent._id,
      agentName: agent.name,
    });

    res.json({ sessionId: session._id, hired: true, queued, jobId });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error hiring agent');
    res.status(500).json({ error: 'Failed to hire agent' });
  }
});

export default router;
