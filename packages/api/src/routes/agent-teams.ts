import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import {
  addAgentToTeam,
  createAgentTeam,
  deleteAgentTeamOwnedBy,
  findAgentTeamOwnedBy,
  listAgentTeams,
  removeAgentFromTeam,
  updateAgentTeam,
} from '../db/agents/agentTeamRepository.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// List user's agent teams
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const teams = await listAgentTeams(getDb(), userId);

    res.json({ teams });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error fetching agent teams');
    res.status(500).json({ error: 'Failed to fetch agent teams' });
  }
});

// Get a single agent team
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const team = await findAgentTeamOwnedBy(getDb(), String(id), userId);

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error: unknown) {
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

    const team = await createAgentTeam(getDb(), {
      name: data.name,
      ...(data.description !== undefined && { description: data.description }),
      creatorOxyUserId: userId,
      agentIds: data.agents ?? [],
      skillIds: data.skills ?? [],
      libraryFileIds: data.knowledge ?? [],
    });

    res.status(201).json({ team });
  } catch (error: unknown) {
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

    const team = await updateAgentTeam(getDb(), String(id), userId, {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.skills !== undefined && { skillIds: data.skills }),
      ...(data.knowledge !== undefined && { libraryFileIds: data.knowledge }),
    });

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error: unknown) {
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

    const deleted = await deleteAgentTeamOwnedBy(getDb(), String(id), userId);

    if (deleted === 0) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ deleted: true });
  } catch (error: unknown) {
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

    if (typeof agentId !== 'string' || agentId === '') {
      return res.status(400).json({ error: 'agentId is required' });
    }

    /**
     * The existence check stays, and it is not redundant with the foreign key.
     *
     * `agent_team_agents.agent_id` references `agents.id`, so a missing agent
     * would be refused anyway — but as a `foreign_key_violation` inside a
     * transaction, which reaches the client as a 500. The read turns that into
     * the 404 the route has always answered.
     */
    const agent = await findAgentById(getDb(), agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const team = await addAgentToTeam(getDb(), String(id), userId, agentId);

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error adding agent to team');
    res.status(500).json({ error: 'Failed to add agent to team' });
  }
});

// Remove an agent from a team
router.delete('/:id/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id, agentId } = req.params;

    const team = await removeAgentFromTeam(getDb(), String(id), userId, String(agentId));

    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    res.json({ team });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error removing agent from team');
    res.status(500).json({ error: 'Failed to remove agent from team' });
  }
});

export default router;
