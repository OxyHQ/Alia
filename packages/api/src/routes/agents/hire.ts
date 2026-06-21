import { Router } from 'express';
import { Agent } from '../../models/agent.js';
import { AgentSession } from '../../models/agent-session.js';
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
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error hiring agent');
    res.status(500).json({ error: 'Failed to hire agent' });
  }
});

export default router;
