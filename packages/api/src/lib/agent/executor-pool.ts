/**
 * Executor Pool — Concurrent Subtask Execution
 *
 * Manages parallel execution of subtasks from the planner's execution plan.
 * Respects dependency ordering and resource limits.
 */

import { getDb } from '../../db/index.js';
import {
  cancelUnsettledAgentSession,
  createAgentSession,
  findAgentSessionById,
} from '../../db/agents/agentSessionRepository.js';
import { findHireableAgentByHandle } from '../../db/agents/agentRepository.js';
import { runAgentSession } from './runner.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import type { Subtask } from './planner-agent.js';

export interface ExecutorResult {
  subtaskId: number;
  subtask: string;
  result: string;
  success: boolean;
  sessionId: string;
  durationMs: number;
}

export interface ExecutorPoolOptions {
  /** Maximum concurrent executors */
  maxConcurrency: number;
  /** Per-executor step limit */
  maxStepsPerExecutor: number;
  /** Per-executor token limit */
  maxTokensPerExecutor: number;
  /** Per-executor timeout in ms */
  timeoutMs: number;
  /** Parent session for context */
  parentSession: {
    _id: string;
    userId: string;
    agentId: string;
    depth: number;
    config: { maxSteps: number; maxTokens: number; maxVMs: number };
  };
}

/**
 * Execute subtasks respecting dependency ordering and concurrency limits.
 *
 * Processes subtasks in dependency order: tasks with no unfinished
 * dependencies run in parallel up to maxConcurrency.
 */
export async function executeSubtasks(
  subtasks: Subtask[],
  opts: ExecutorPoolOptions,
): Promise<ExecutorResult[]> {
  const results = new Map<number, ExecutorResult>();
  const pending = new Set(subtasks.map(s => s.id));
  const running = new Map<number, Promise<ExecutorResult>>();

  while (pending.size > 0 || running.size > 0) {
    // Find subtasks whose dependencies are all satisfied
    const ready = subtasks.filter(s =>
      pending.has(s.id) &&
      !running.has(s.id) &&
      s.dependsOn.every(dep => results.has(dep)),
    );

    // Launch ready subtasks up to concurrency limit
    const slotsAvailable = opts.maxConcurrency - running.size;
    const toStart = ready.slice(0, slotsAvailable);

    for (const subtask of toStart) {
      pending.delete(subtask.id);
      const promise = executeSubtask(subtask, opts, results);
      running.set(subtask.id, promise);

      log.agents.info(
        // The description is the planner model's own words about the user's task.
        { subtaskId: subtask.id, running: running.size },
        'ExecutorPool: starting subtask',
      );
    }

    if (running.size === 0 && pending.size > 0) {
      // Deadlock: remaining tasks have unsatisfied dependencies
      log.agents.warn({ pending: [...pending] }, 'ExecutorPool: deadlock detected, forcing remaining tasks');
      for (const id of pending) {
        const subtask = subtasks.find(s => s.id === id)!;
        const promise = executeSubtask(subtask, opts, results);
        running.set(id, promise);
        pending.delete(id);
      }
    }

    // Wait for at least one to complete
    if (running.size > 0) {
      const settled = await Promise.race(
        [...running.entries()].map(([id, p]) => p.then(r => ({ id, result: r }))),
      );

      results.set(settled.id, settled.result);
      running.delete(settled.id);

      log.agents.info(
        { subtaskId: settled.id, success: settled.result.success, durationMs: settled.result.durationMs },
        'ExecutorPool: subtask completed',
      );
    }
  }

  // Return results in subtask order
  return subtasks.map(s => results.get(s.id)!).filter(Boolean);
}

async function executeSubtask(
  subtask: Subtask,
  opts: ExecutorPoolOptions,
  previousResults: Map<number, ExecutorResult>,
): Promise<ExecutorResult> {
  const startMs = Date.now();

  try {
    // Build context from dependency results
    const depContext = subtask.dependsOn
      .map(depId => previousResults.get(depId))
      .filter(Boolean)
      .map(r => `[Result from "${r!.subtask}"]: ${r!.result.slice(0, 500)}`)
      .join('\n');

    const taskWithContext = depContext
      ? `${subtask.description}\n\n## Context from previous steps:\n${depContext}`
      : subtask.description;

    // Find the target agent (or use the parent's agent)
    let agentId = opts.parentSession.agentId;
    if (subtask.agentHandle) {
      const specialistAgent = await findHireableAgentByHandle(
        getDb(),
        subtask.agentHandle.replace(/^@/, ''),
      );
      if (specialistAgent) {
        agentId = specialistAgent._id;
      }
    }

    // Determine resource limits based on complexity
    const stepsMultiplier = subtask.complexity === 'light' ? 0.3 : subtask.complexity === 'medium' ? 0.6 : 1;
    const maxSteps = Math.max(5, Math.floor(opts.maxStepsPerExecutor * stepsMultiplier));
    const maxTokens = Math.max(5000, Math.floor(opts.maxTokensPerExecutor * stepsMultiplier));

    // Create executor session
    const executorSession = await createAgentSession(getDb(), {
      agentId,
      oxyUserId: opts.parentSession.userId,
      parentSessionId: opts.parentSession._id,
      task: taskWithContext,
      status: 'queued',
      depth: opts.parentSession.depth + 1,
      config: {
        maxSteps,
        maxTokens,
        maxVMs: 1,
      },
    });

    // Execute with timeout — cancel the session on timeout so the runner's
    // cancellation check picks it up and stops the orphaned execution.
    const sessionPromise = runAgentSession(executorSession._id);
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('Executor timeout')), opts.timeoutMs);
    });

    try {
      await Promise.race([sessionPromise, timeoutPromise]);
    } catch (raceErr: unknown) {
      if (raceErr instanceof Error && raceErr.message === 'Executor timeout') {
        // Mark the session cancelled so the running agent loop stops — and only
        // if it has not already settled, which is a predicate in the statement
        // rather than a read this handler could lose a race against.
        await cancelUnsettledAgentSession(
          getDb(),
          executorSession._id,
          'Executor timeout — session cancelled',
        ).catch(() => false);
      }
      throw raceErr;
    } finally {
      clearTimeout(timeoutHandle!);
    }

    // Read result
    const completed = await findAgentSessionById(getDb(), executorSession._id);
    const result = completed?.result || 'No result returned';
    const success = completed?.status === 'completed';

    return {
      subtaskId: subtask.id,
      subtask: subtask.description,
      result,
      success,
      sessionId: executorSession._id,
      durationMs: Date.now() - startMs,
    };
  } catch (err: unknown) {
    return {
      subtaskId: subtask.id,
      subtask: subtask.description,
      result: `Executor failed: ${getErrorMessage(err)}`,
      success: false,
      sessionId: '',
      durationMs: Date.now() - startMs,
    };
  }
}
