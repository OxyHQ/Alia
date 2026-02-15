import { Router } from 'express';
import { randomUUID } from 'crypto';
import { generateText } from 'ai';
import { WorkflowExecution } from '../../models/workflow-execution.js';
import { authenticateToken } from '../../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../../lib/chat-core.js';
import { UserMemory } from '../../models/user-memory.js';
import { getIO } from '../../socket.js';
import type { Request, Response } from 'express';
import { log } from '../../lib/logger.js';

// Response types for external API calls
interface OpenAIImageResponse {
  data: { url: string }[];
}

interface OpenAIErrorResponse {
  error?: { message?: string };
}

interface GitHubContentResponse {
  content: string;
}

const router = Router();

// Require authentication for all canvas execute routes
router.use(authenticateToken);

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
      oxyUserId: req.userId,
      workflowId: workflowId || 'temp',
      executionId,
      status: 'running',
      results: [],
      finalOutput: '',
      startedAt: new Date()
    });

    try {
      // Execute the workflow
      const { results, finalOutput } = await executeWorkflow(nodes, edges, req.userId!, executionId);

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
    log.canvas.error({ err: error }, 'Error executing workflow');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to execute workflow'
    });
  }
});

// Helper function to execute a workflow
async function executeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  userId: string,
  executionId: string
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

      const output = await executeNode(node, inputs.join('\n\n'), userId);

      nodeOutputs.set(nodeId, output);

      results.push({
        nodeId: node.id,
        nodeType: node.type,
        output,
        error: undefined,
        timestamp: new Date()
      });

      const io = getIO();
      if (io) {
        io.to(`workflow:${executionId}`).emit('workflow-progress', {
          executionId,
          nodeId: node.id,
          nodeType: node.type,
          status: 'completed',
          output
        });
      }
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

async function executeNode(node: WorkflowNode, input: string, userId: string): Promise<any> {
  switch (node.type) {
    case 'textInput':
      return node.data.text || '';

    case 'aiText': {
      const modelId = node.data.model || getDefaultAliaModel();
      const resolved = await resolveModel(modelId);
      const model = getAIModel(resolved.keyConfig);
      const builtPrompt = node.data.prompt
        ? node.data.prompt.replace(/\{\{input\}\}/g, input)
        : input;
      const result = await generateText({
        model,
        prompt: builtPrompt,
        system: node.data.systemPrompt
      });
      return result.text;
    }

    case 'aiImage': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
      }
      const imagePrompt = node.data.prompt
        ? node.data.prompt.replace(/\{\{input\}\}/g, input)
        : input;
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          prompt: imagePrompt,
          n: 1,
          size: node.data.size || '1024x1024'
        })
      });
      if (!response.ok) {
        const err = await response.json() as OpenAIErrorResponse;
        throw new Error(`OpenAI image generation failed: ${err.error?.message || response.statusText}`);
      }
      const data = await response.json() as OpenAIImageResponse;
      return data.data[0].url;
    }

    case 'github': {
      const githubUrl = node.data.githubUrl;
      if (!githubUrl) {
        throw new Error('GitHub URL is required');
      }
      const url = new URL(githubUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        throw new Error('Invalid GitHub URL: must contain owner and repo');
      }
      const owner = parts[0];
      const repo = parts[1];
      let apiUrl: string;
      if (parts.length >= 4 && parts[2] === 'blob') {
        const path = parts.slice(4).join('/');
        apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${parts[3]}`;
      } else if (parts.length >= 3) {
        const path = parts.slice(2).join('/');
        apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      } else {
        apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
      }
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Alia-Workflow-Engine'
      };
      if (node.data.token) {
        headers['Authorization'] = `Bearer ${node.data.token}`;
      }
      const ghResponse = await fetch(apiUrl, { headers });
      if (!ghResponse.ok) {
        throw new Error(`GitHub API error: ${ghResponse.status} ${ghResponse.statusText}`);
      }
      const ghData = await ghResponse.json() as GitHubContentResponse;
      const content = Buffer.from(ghData.content, 'base64').toString('utf-8');
      return content;
    }

    case 'merge':
      return input;

    case 'output':
      return input;

    case 'condition': {
      const operator = node.data.operator;
      const value = node.data.value || '';
      let matches = false;
      switch (operator) {
        case 'contains':
          matches = input.includes(value);
          break;
        case 'equals':
          matches = input === value;
          break;
        case 'startsWith':
          matches = input.startsWith(value);
          break;
        case 'endsWith':
          matches = input.endsWith(value);
          break;
        case 'matches':
          matches = new RegExp(value).test(input);
          break;
        case 'greaterThan':
          matches = parseFloat(input) > parseFloat(value);
          break;
        case 'lessThan':
          matches = parseFloat(input) < parseFloat(value);
          break;
        default:
          matches = !!input;
      }
      return matches ? input : '';
    }

    case 'memory': {
      const operation = node.data.operation;
      const memoryKey = node.data.memoryKey;
      if (!memoryKey) {
        throw new Error('Memory key is required');
      }
      if (operation === 'read') {
        const userMemory = await UserMemory.findOne({ oxyUserId: userId });
        if (!userMemory) return '';
        const entry = userMemory.memories.find(m => m.key === memoryKey);
        return entry ? entry.value : '';
      } else if (operation === 'write') {
        const existing = await UserMemory.findOne({
          oxyUserId: userId,
          'memories.key': memoryKey
        });
        if (existing) {
          await UserMemory.updateOne(
            { oxyUserId: userId, 'memories.key': memoryKey },
            { $set: { 'memories.$.value': input, 'memories.$.updatedAt': new Date() } }
          );
        } else {
          await UserMemory.findOneAndUpdate(
            { oxyUserId: userId },
            { $push: { memories: { key: memoryKey, value: input, createdAt: new Date(), updatedAt: new Date() } } },
            { upsert: true }
          );
        }
        return input;
      }
      throw new Error(`Unknown memory operation: ${operation}`);
    }

    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

export default router;
