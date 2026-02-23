import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { AgentTeam } from '../models/agent-team.js';
import { Agent } from '../models/agent.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// List user's agent teams
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const teams = await AgentTeam.find({ creator: userId })
      .populate('agents', 'name handle avatar tagline status')
      .populate('skills', 'skillId title icon color')
      .populate('knowledge', 'name type category url')
      .sort({ createdAt: -1 });

    res.json({ teams });
  } catch (error) {
    log.agents.error({ err: error }, 'Error fetching agent teams');
    res.status(500).json({ error: 'Failed to fetch agent teams' });
  }
});

// Get a single agent team
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const team = await AgentTeam.findOne({ _id: id, creator: userId })
      .populate('agents')
      .populate('skills', 'skillId title icon color')
      .populate('knowledge', 'name type category url');

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error) {
    log.agents.error({ err: error }, 'Error fetching agent team');
    res.status(500).json({ error: 'Failed to fetch agent team' });
  }
});

// Create a new agent team
const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  knowledge: z.array(z.string()).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const data = createTeamSchema.parse(req.body);

    const team = new AgentTeam({
      name: data.name,
      description: data.description,
      creator: userId,
      agents: data.agents || [],
      skills: data.skills || [],
      knowledge: data.knowledge || [],
    });

    await team.save();
    await team.populate('agents', 'name handle avatar tagline status');

    res.status(201).json({ team });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.agents.error({ err: error }, 'Error creating agent team');
    res.status(500).json({ error: 'Failed to create agent team' });
  }
});

// Update an agent team
const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  skills: z.array(z.string()).optional(),
  knowledge: z.array(z.string()).optional(),
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const data = updateTeamSchema.parse(req.body);

    const team = await AgentTeam.findOneAndUpdate(
      { _id: id, creator: userId },
      { $set: data },
      { returnDocument: 'after' },
    ).populate('agents', 'name handle avatar tagline status');

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.agents.error({ err: error }, 'Error updating agent team');
    res.status(500).json({ error: 'Failed to update agent team' });
  }
});

// Delete an agent team
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const team = await AgentTeam.findOneAndDelete({ _id: id, creator: userId });

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ deleted: true });
  } catch (error) {
    log.agents.error({ err: error }, 'Error deleting agent team');
    res.status(500).json({ error: 'Failed to delete agent team' });
  }
});

// Add an agent to a team
router.post('/:id/agents', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    // Verify agent exists
    const agent = await Agent.findById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const team = await AgentTeam.findOneAndUpdate(
      { _id: id, creator: userId },
      { $addToSet: { agents: agentId } },
      { returnDocument: 'after' },
    ).populate('agents', 'name handle avatar tagline status');

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error) {
    log.agents.error({ err: error }, 'Error adding agent to team');
    res.status(500).json({ error: 'Failed to add agent to team' });
  }
});

// Remove an agent from a team
router.delete('/:id/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id, agentId } = req.params;

    const team = await AgentTeam.findOneAndUpdate(
      { _id: id, creator: userId },
      { $pull: { agents: agentId } },
      { returnDocument: 'after' },
    ).populate('agents', 'name handle avatar tagline status');

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error) {
    log.agents.error({ err: error }, 'Error removing agent from team');
    res.status(500).json({ error: 'Failed to remove agent from team' });
  }
});

export default router;
