import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import {
  createWorkflow,
  deleteExecutionsForWorkflow,
  deleteWorkflow,
  findWorkflow,
  listExecutions,
  listWorkflows,
  updateWorkflow,
} from '../../db/automation/workflowRepository.js';
import { authenticateToken } from '../../middleware/auth.js';
import type { Request, Response } from 'express';
import { log } from '../../lib/logger.js';

const router = Router();

// Require authentication for all canvas workflow routes
router.use(authenticateToken);

// Get all workflows
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const workflows = await listWorkflows(getDb(), req.userId);

    const formattedWorkflows = workflows.map(w => ({
      id: w.workflowId,
      name: w.name,
      description: w.description,
      nodes: w.nodes,
      edges: w.edges,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt
    }));

    res.json({ workflows: formattedWorkflows });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error fetching workflows');
    res.status(500).json({ error: 'Failed to fetch workflows' });
  }
});

// Get a specific workflow
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const workflow = await findWorkflow(getDb(), req.userId, String(req.params.id));

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json({
      workflow: {
        id: workflow.workflowId,
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      }
    });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error fetching workflow');
    res.status(500).json({ error: 'Failed to fetch workflow' });
  }
});

// Create a new workflow
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, description, nodes, edges } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Workflow name is required' });
    }

    const workflowId = randomUUID();

    const workflow = await createWorkflow(getDb(), {
      oxyUserId: req.userId,
      workflowId,
      name,
      description: description || '',
      nodes: nodes || [],
      edges: edges || [],
    });

    res.json({
      workflow: {
        id: workflow.workflowId,
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      }
    });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error creating workflow');
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// Update a workflow
router.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, description, nodes, edges } = req.body;

    // No `updatedAt` here: the column carries `$onUpdate`, so drizzle writes it
    // on every update. Setting it by hand would be the second authority the
    // `pre('save')` hook already was.
    const workflow = await updateWorkflow(getDb(), req.userId, String(req.params.id), {
      name,
      description,
      nodes,
      edges,
    });

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json({
      workflow: {
        id: workflow.workflowId,
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      }
    });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error updating workflow');
    res.status(500).json({ error: 'Failed to update workflow' });
  }
});

// Delete a workflow
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const workflow = await deleteWorkflow(getDb(), req.userId, String(req.params.id));

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Also delete all executions for this workflow
    await deleteExecutionsForWorkflow(getDb(), String(req.params.id));

    res.json({ message: 'Workflow deleted successfully' });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error deleting workflow');
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// Get execution history for a workflow
router.get('/:id/executions', async (req: Request, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const executions = await listExecutions(getDb(), req.userId, String(req.params.id));

    const formattedExecutions = executions.map(e => ({
      id: e.executionId,
      workflowId: e.workflowId,
      status: e.status,
      results: e.results,
      finalOutput: e.finalOutput,
      startedAt: e.startedAt,
      completedAt: e.completedAt
    }));

    res.json({ executions: formattedExecutions });
  } catch (error) {
    log.canvas.error({ err: error }, 'Error fetching execution history');
    res.status(500).json({ error: 'Failed to fetch execution history' });
  }
});

export default router;
