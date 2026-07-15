/**
 * Orchestrator — Three-Layer Agent Coordination (Manus Pattern)
 *
 * Coordinates: Planner → Executors → Verifier
 *
 * Flow:
 *   1. Planner decomposes the task into subtasks with dependencies
 *   2. Executor pool runs subtasks respecting parallelism and dependencies
 *   3. Verifier checks output quality — retry on failure (max 1 retry)
 *   4. Synthesize final result from executor outputs
 *
 * The orchestrator activates for complex tasks (>1 subtask expected).
 * Simple tasks skip orchestration and use the standard single-agent loop.
 */

import { generateText } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { generatePlan, type ExecutionPlan } from './planner-agent.js';
import { executeSubtasks, type ExecutorResult } from './executor-pool.js';
import { verifyResults, type VerificationResult } from './verifier-agent.js';
import { EventStream } from './event-stream.js';
import { MAX_DELEGATION_DEPTH } from '../constants.js';

export interface OrchestrationOptions {
  /** The task to execute */
  task: string;
  /** Parent session info */
  session: {
    _id: any;
    userId: any;
    agentId: any;
    depth: number;
    config: { maxSteps: number; maxTokens: number; maxVMs: number };
  };
  /** Agent info for context */
  agent?: { name?: string; description?: string };
  /** Event stream for logging */
  eventStream: EventStream;
  /** Max parallel executors */
  maxConcurrency?: number;
  /** Max retry attempts after verification failure */
  maxRetries?: number;
}

export interface OrchestrationResult {
  success: boolean;
  result: string;
  plan: ExecutionPlan;
  executorResults: ExecutorResult[];
  verification: VerificationResult | null;
  totalDurationMs: number;
}

/**
 * Run the full three-layer orchestration pipeline.
 *
 * Planner → Executors (parallel) → Verifier → (retry if needed) → Result
 */
export async function orchestrate(opts: OrchestrationOptions): Promise<OrchestrationResult> {
  const startMs = Date.now();
  const maxConcurrency = opts.maxConcurrency ?? 3;
  const maxRetries = opts.maxRetries ?? 1;

  // Check depth limit
  if (opts.session.depth >= MAX_DELEGATION_DEPTH) {
    return {
      success: false,
      result: 'Orchestration depth limit reached. Cannot create sub-agents at this depth.',
      plan: { analysis: '', subtasks: [], parallelGroups: [], strategy: '' },
      executorResults: [],
      verification: null,
      totalDurationMs: Date.now() - startMs,
    };
  }

  opts.eventStream.append('system_message', 'Orchestrator: activating three-layer execution (Planner → Executors → Verifier)');

  // ── Layer 1: Planning ──

  opts.eventStream.append('thinking', 'Orchestrator: decomposing task into subtasks...');

  const plan = await generatePlan(opts.task, {
    agentName: opts.agent?.name,
    agentDescription: opts.agent?.description,
    maxSubtasks: Math.min(Math.floor(opts.session.config.maxSteps / 5), 10),
  });

  opts.eventStream.append('plan_update', [
    `Strategy: ${plan.strategy}`,
    `Analysis: ${plan.analysis}`,
    `Subtasks (${plan.subtasks.length}):`,
    ...plan.subtasks.map(s => `  ${s.id}. [${s.complexity}] ${s.description}${s.dependsOn.length ? ` (after: ${s.dependsOn.join(', ')})` : ''}`),
    plan.parallelGroups.length > 0 ? `Parallel groups: ${plan.parallelGroups.map(g => `[${g.join(', ')}]`).join(', ')}` : '',
  ].filter(Boolean).join('\n'));

  // If only 1 subtask, no point orchestrating — return the single task
  if (plan.subtasks.length <= 1) {
    opts.eventStream.append('system_message', 'Orchestrator: single subtask — skipping multi-agent execution');
    return {
      success: true,
      result: '',  // Caller should run single-agent mode
      plan,
      executorResults: [],
      verification: null,
      totalDurationMs: Date.now() - startMs,
    };
  }

  // ── Layer 2: Execution ──

  opts.eventStream.append('system_message', `Orchestrator: launching ${plan.subtasks.length} executors (max ${maxConcurrency} concurrent)`);

  // Calculate per-executor budgets from parent session
  const maxStepsPerExecutor = Math.max(5, Math.floor(opts.session.config.maxSteps / plan.subtasks.length));
  const maxTokensPerExecutor = Math.max(5000, Math.floor(opts.session.config.maxTokens / plan.subtasks.length));
  const timeoutMs = Math.max(30_000, Math.floor(300_000 / plan.subtasks.length) * plan.subtasks.length);

  const executorResults = await executeSubtasks(plan.subtasks, {
    maxConcurrency,
    maxStepsPerExecutor,
    maxTokensPerExecutor,
    timeoutMs,
    parentSession: opts.session,
  });

  for (const r of executorResults) {
    opts.eventStream.append(
      r.success ? 'observation' : 'error',
      `Executor ${r.subtaskId} (${r.subtask.slice(0, 80)}): ${r.success ? 'completed' : 'failed'} in ${Math.round(r.durationMs / 1000)}s\n${r.result.slice(0, 500)}`,
      { toolName: 'executor', durationMs: r.durationMs },
    );
  }

  // ── Layer 3: Verification ──

  opts.eventStream.append('thinking', 'Orchestrator: verifying executor outputs...');

  let verification = await verifyResults(
    opts.task,
    executorResults.map(r => ({ subtask: r.subtask, result: r.result, success: r.success })),
  );

  opts.eventStream.append(
    verification.passed ? 'observation' : 'error',
    `Verification: ${verification.passed ? 'PASSED' : 'FAILED'} (score: ${verification.score}/10)\n${verification.summary}${verification.issues.length ? `\nIssues: ${verification.issues.join('; ')}` : ''}`,
  );

  // ── Retry on verification failure ──

  if (!verification.passed && maxRetries > 0) {
    opts.eventStream.append('system_message', `Orchestrator: verification failed, retrying failed subtasks...`);

    // Re-run only failed subtasks with verification feedback
    const failedSubtasks = plan.subtasks.filter(s => {
      const result = executorResults.find(r => r.subtaskId === s.id);
      return !result?.success;
    });

    if (failedSubtasks.length > 0) {
      // Append feedback to failed subtask descriptions
      const feedbackSubtasks = failedSubtasks.map(s => ({
        ...s,
        description: `${s.description}\n\nPrevious attempt failed. Feedback: ${verification.suggestions.join('. ')}`,
        dependsOn: [], // Remove dependencies for retry
      }));

      const retryResults = await executeSubtasks(feedbackSubtasks, {
        maxConcurrency,
        maxStepsPerExecutor,
        maxTokensPerExecutor,
        timeoutMs,
        parentSession: opts.session,
      });

      // Merge retry results
      for (const retry of retryResults) {
        const idx = executorResults.findIndex(r => r.subtaskId === retry.subtaskId);
        if (idx >= 0) executorResults[idx] = retry;
      }

      // Re-verify
      verification = await verifyResults(
        opts.task,
        executorResults.map(r => ({ subtask: r.subtask, result: r.result, success: r.success })),
      );

      opts.eventStream.append(
        verification.passed ? 'observation' : 'error',
        `Re-verification: ${verification.passed ? 'PASSED' : 'FAILED'} (score: ${verification.score}/10)\n${verification.summary}`,
      );
    }
  }

  // ── Synthesize final result ──

  const finalResult = await synthesizeResult(opts.task, executorResults);

  opts.eventStream.append('complete', `Orchestrator: finished in ${Math.round((Date.now() - startMs) / 1000)}s`);

  return {
    success: verification.passed,
    result: finalResult,
    plan,
    executorResults,
    verification,
    totalDurationMs: Date.now() - startMs,
  };
}

/**
 * Synthesize a coherent final result from multiple executor outputs.
 */
async function synthesizeResult(
  task: string,
  results: ExecutorResult[],
): Promise<string> {
  // If only successful results, just concatenate
  const successResults = results.filter(r => r.success);
  if (successResults.length === 0) {
    return 'All subtasks failed. No result produced.';
  }

  if (successResults.length === 1) {
    return successResults[0].result;
  }

  // For multiple results, use a model to synthesize
  try {
    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      return successResults.map(r => `## ${r.subtask}\n${r.result}`).join('\n\n');
    }

    const model = getAIModel(resolved.keyConfig);
    const resultsSummary = successResults
      .map(r => `### ${r.subtask}\n${r.result}`)
      .join('\n\n');

    const synthesis = await generateText({
      model,
      system: 'Synthesize the results from multiple subtasks into a coherent, unified response. Be concise but complete.',
      messages: [{ role: 'user', content: `Original task: ${task}\n\nSubtask results:\n\n${resultsSummary}` }],
      temperature: 0.2,
      maxRetries: 1,
    });

    return synthesis.text || successResults.map(r => r.result).join('\n\n');
  } catch {
    return successResults.map(r => `## ${r.subtask}\n${r.result}`).join('\n\n');
  }
}

/**
 * Heuristic to determine if a task should use orchestrated execution.
 *
 * Returns true for tasks that likely benefit from decomposition:
 * - Multi-part tasks (lists, "and", "then")
 * - Complex tasks (analysis, research, implementation)
 * - Tasks mentioning multiple targets (repos, files, APIs)
 */
export function shouldOrchestrate(task: string, depth: number): boolean {
  // Never orchestrate at max depth
  if (depth >= MAX_DELEGATION_DEPTH - 1) return false;

  // Task length heuristic: very short tasks are simple
  if (task.length < 50) return false;

  const multiPartIndicators = [
    /\b(and then|after that|next|finally|also|additionally)\b/i,
    /\b(first|second|third|step \d|phase \d)\b/i,
    /\d+\.\s/,  // Numbered lists
    /\b(multiple|several|various|each|every|all)\b.*\b(files?|repos?|APIs?|services?|pages?|endpoints?|components?)\b/i,
    /\b(compare|contrast|evaluate|analyze)\b.*\b(and|versus|vs|with)\b/i,
  ];

  const complexIndicators = [
    /\b(research|investigate|analyze|audit|review|assess)\b/i,
    /\b(implement|build|create|develop|design)\b.*\b(system|architecture|module|feature)\b/i,
    /\b(migrate|refactor|restructure|overhaul)\b/i,
  ];

  const multiPartScore = multiPartIndicators.filter(r => r.test(task)).length;
  const complexScore = complexIndicators.filter(r => r.test(task)).length;

  return multiPartScore >= 2 || (multiPartScore >= 1 && complexScore >= 1);
}
