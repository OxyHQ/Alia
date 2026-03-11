/**
 * Planner Agent — Task Decomposition Layer
 *
 * First layer of the three-layer orchestration (Manus pattern):
 *   Planner → Executors → Verifier
 *
 * Uses a capable model to analyze a complex task and decompose it into
 * a structured execution plan with subtasks, dependencies, and parallelism hints.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { log } from '../logger.js';

export interface Subtask {
  id: number;
  description: string;
  /** Which subtask IDs must complete before this one starts */
  dependsOn: number[];
  /** Estimated complexity: light tasks use cheap models, heavy ones use capable models */
  complexity: 'light' | 'medium' | 'heavy';
  /** Which agent handle is best suited (null = use default) */
  agentHandle?: string;
}

export interface ExecutionPlan {
  /** High-level analysis of the task */
  analysis: string;
  /** Ordered list of subtasks */
  subtasks: Subtask[];
  /** Groups of subtask IDs that can run in parallel */
  parallelGroups: number[][];
  /** Overall strategy description */
  strategy: string;
}

const SubtaskSchema = z.object({
  id: z.number(),
  description: z.string(),
  dependsOn: z.array(z.number()),
  complexity: z.enum(['light', 'medium', 'heavy']),
  agentHandle: z.string().optional(),
});

const ExecutionPlanSchema = z.object({
  analysis: z.string().describe('Brief analysis of the task and its requirements'),
  subtasks: z.array(SubtaskSchema).min(1).max(20),
  parallelGroups: z.array(z.array(z.number())).describe('Groups of subtask IDs that can run concurrently'),
  strategy: z.string().describe('Overall execution strategy'),
});

/**
 * Generate an execution plan for a complex task.
 *
 * Uses a thinking/capable model to decompose the task, identify
 * dependencies, and determine parallelism opportunities.
 */
export async function generatePlan(
  task: string,
  context?: {
    agentName?: string;
    agentDescription?: string;
    availableAgents?: string[];
    maxSubtasks?: number;
  },
): Promise<ExecutionPlan> {
  const maxSubtasks = context?.maxSubtasks ?? 10;

  // Use the best available model for planning
  const plannerModels = ['alia-v1-thinking', 'alia-v1-pro', 'alia-v1'];
  let resolved: Awaited<ReturnType<typeof resolveModel>> | null = null;

  for (const modelId of plannerModels) {
    resolved = await resolveModel(modelId);
    if (resolved) break;
  }

  if (!resolved) {
    resolved = await resolveModel(getDefaultAliaModel());
  }

  if (!resolved) {
    throw new Error('No AI models available for planning');
  }

  const model = getAIModel(resolved.keyConfig);

  const systemPrompt = `You are a task planning agent. Your job is to decompose a complex task into smaller, executable subtasks.

Rules:
- Each subtask should be independently executable by an agent
- Identify which subtasks can run in parallel (no dependencies between them)
- Keep subtasks focused and atomic — one clear objective each
- Maximum ${maxSubtasks} subtasks
- Mark complexity: "light" for simple lookups/reads, "medium" for standard operations, "heavy" for complex analysis/coding
- dependsOn should reference subtask IDs that must complete first
- parallelGroups should list sets of subtask IDs that can run concurrently
${context?.availableAgents?.length ? `\nAvailable specialist agents: ${context.availableAgents.join(', ')}` : ''}
${context?.agentName ? `\nYou are planning for agent: ${context.agentName}` : ''}
${context?.agentDescription ? `\nAgent description: ${context.agentDescription}` : ''}`;

  try {
    const result = await generateObject({
      model,
      schema: ExecutionPlanSchema,
      system: systemPrompt,
      prompt: `Decompose this task into subtasks:\n\n${task}`,
      temperature: 0.2,
      maxRetries: 1,
    });

    const plan = result.object as ExecutionPlan;

    log.agents.info(
      { subtaskCount: plan.subtasks.length, parallelGroups: plan.parallelGroups.length },
      'Planner: generated execution plan',
    );

    return plan;
  } catch (err: unknown) {
    log.agents.error({ err }, 'Planner: failed to generate plan');
    // Fallback: single subtask = the original task
    return {
      analysis: 'Planning failed — executing task as a single unit.',
      subtasks: [{ id: 1, description: task, dependsOn: [], complexity: 'heavy' }],
      parallelGroups: [[1]],
      strategy: 'Direct execution (planning fallback)',
    };
  }
}
