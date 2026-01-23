import { Router } from 'express';
import { randomUUID } from 'crypto';
import { WorkflowExecution } from '../../models/workflow-execution.js';
import type { Request, Response } from 'express';

const router = Router();

// Temporary demo user ID (will be replaced with auth library later)
const DEMO_USER_ID = '000000000000000000000001';

interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any>;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  animated?: boolean;
}

// Execute a workflow
router.post('/', async (req: Request, res: Response) => {
  try {
    const { nodes, edges, workflowId } = req.body as {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      workflowId?: string;
    };

    if (!nodes || !Array.isArray(nodes)) {
      return res.status(400).json({ error: 'Invalid workflow nodes' });
    }

    if (!edges || !Array.isArray(edges)) {
      return res.status(400).json({ error: 'Invalid workflow edges' });
    }

    const executionId = randomUUID();

    // Create execution record
    const execution = await WorkflowExecution.create({
      oxyUserId: DEMO_USER_ID,
      workflowId: workflowId || 'temp',
      executionId,
      status: 'running',
      results: [],
      finalOutput: '',
      startedAt: new Date()
    });

    try {
      // Execute the workflow
      const { results, finalOutput } = await executeWorkflow(nodes, edges, DEMO_USER_ID);

      // Update execution with results
      execution.status = 'completed';
      execution.results = results;
      execution.finalOutput = finalOutput;
      execution.completedAt = new Date();
      await execution.save();

      res.json({
        executionId,
        status: 'completed',
        results,
        finalOutput
      });
    } catch (error) {
      // Update execution with error
      execution.status = 'failed';
      execution.finalOutput = error instanceof Error ? error.message : 'Unknown error';
      execution.completedAt = new Date();
      await execution.save();

      throw error;
    }
  } catch (error) {
    console.error('Error executing workflow:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to execute workflow'
    });
  }
});

// Helper function to execute a workflow
async function executeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  userId: string
): Promise<{ results: any[]; finalOutput: string }> {
  const results: any[] = [];
  const nodeOutputs = new Map<string, any>();

  // Build adjacency list for the workflow graph
  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacencyList.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    adjacencyList.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  // Topological sort to determine execution order
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const executionOrder: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    executionOrder.push(nodeId);

    const neighbors = adjacencyList.get(nodeId) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Execute nodes in order
  for (const nodeId of executionOrder) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;

    try {
      // Get inputs from parent nodes
      const inputs: any[] = [];
      for (const edge of edges) {
        if (edge.target === nodeId) {
          const parentOutput = nodeOutputs.get(edge.source);
          if (parentOutput !== undefined) {
            inputs.push(parentOutput);
          }
        }
      }

      // Execute the node
      const output = await executeNode(node, inputs.join('\n\n'));

      // Store output
      nodeOutputs.set(nodeId, output);

      results.push({
        nodeId: node.id,
        nodeType: node.type,
        output,
        error: undefined,
        timestamp: new Date()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        nodeId: node.id,
        nodeType: node.type,
        output: null,
        error: errorMessage,
        timestamp: new Date()
      });
      throw new Error(`Node ${node.id} (${node.type}) failed: ${errorMessage}`);
    }
  }

  // Find output nodes
  const outputNodes = nodes.filter(n => n.type === 'output');
  let finalOutput = '';

  if (outputNodes.length > 0) {
    const outputs = outputNodes.map(n => nodeOutputs.get(n.id)).filter(Boolean);
    finalOutput = outputs.join('\n\n');
  } else {
    // Use the last node's output as final output
    const lastNodeId = executionOrder[executionOrder.length - 1];
    finalOutput = nodeOutputs.get(lastNodeId) || '';
  }

  return { results, finalOutput };
}

// Execute a single node
async function executeNode(node: WorkflowNode, input: string): Promise<any> {
  switch (node.type) {
    case 'textInput':
      return node.data.text || '';

    case 'aiText':
      // TODO: Implement AI text generation
      // For now, return a placeholder
      return `AI Text Node (${node.data.label}): Would generate text using ${node.data.provider} ${node.data.model}\nPrompt: ${node.data.prompt}\nInput: ${input}`;

    case 'aiImage':
      // TODO: Implement AI image generation
      return `AI Image Node (${node.data.label}): Would generate image using ${node.data.provider}`;

    case 'github':
      // TODO: Implement GitHub integration
      return `GitHub Node (${node.data.label}): Would fetch from ${node.data.githubUrl}`;

    case 'merge':
      return input;

    case 'output':
      return input;

    case 'condition':
      // TODO: Implement condition logic
      return input;

    case 'memory':
      // TODO: Implement memory operations
      return `Memory Node (${node.data.label}): ${node.data.operation} ${node.data.memoryKey}`;

    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

export default router;
