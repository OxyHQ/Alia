/**
 * Subtask Delegation Tool
 * Allows the AI to delegate subtasks to other models.
 *
 * Production safety:
 * - Max 3 concurrent subtasks per invocation
 * - 30s timeout per subtask
 * - No nesting (subtasks cannot spawn more subtasks)
 * - Uses Promise.allSettled — one failure doesn't kill others
 */

import { tool, generateText } from 'ai';
import { z } from 'zod';
import { resolveModel, getAIModel } from '../chat-core.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const MAX_CONCURRENT_SUBTASKS = 3;
const SUBTASK_TIMEOUT_MS = 30000;

export interface SubtaskResult {
  task: string;
  model: string;
  result: string | null;
  error: string | null;
  latencyMs: number;
  tokensUsed: number;
}

/**
 * Run a single subtask with timeout
 */
async function runSubtask(
  task: string,
  preferredModel?: string,
  systemContext?: string,
): Promise<SubtaskResult> {
  const start = Date.now();
  /**
   * `alia-v1` is the alias delegation has actually been running on.
   *
   * The previous default was `alia-flash`, which is not one of the thirteen
   * registered aliases. That was not rejected anywhere: resolution reaches
   * `internal/providers/lib/fallback-engine.ts:82`, whose first act is
   * `isAliaModel(aliasModelId) ? aliasModelId : 'alia-v1'`, and `isAliaModel`
   * tests membership of `ALIA_MODELS`. So every subtask ran on `alia-v1` while
   * the result below reported `model: 'alia-flash'` to the caller.
   *
   * Naming the alias it already resolved to keeps behaviour identical and
   * removes the false report. It is deliberately NOT `getDefaultAliaModel()`,
   * which returns `alia-lite` — that would be a behaviour change wearing a
   * cleanup's clothes. Registering `alia-flash` was not an option either: ADR
   * 0002 freezes the alias set.
   */
  const aliasModelId = preferredModel || 'alia-v1';

  try {
    const resolved = await resolveModel(aliasModelId);
    if (!resolved) {
      return {
        task,
        model: aliasModelId,
        result: null,
        error: 'No model available for subtask',
        latencyMs: Date.now() - start,
        tokensUsed: 0,
      };
    }

    const model = getAIModel(resolved.keyConfig);

    // Create an AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUBTASK_TIMEOUT_MS);

    try {
      const result = await generateText({
        model,
        system: systemContext || 'You are a helpful assistant completing a subtask. Be concise and focused.',
        prompt: task,
        maxOutputTokens: 2048,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);

      return {
        task,
        model: aliasModelId,
        result: result.text,
        error: null,
        latencyMs: Date.now() - start,
        tokensUsed: result.usage?.totalTokens || 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: unknown) {
    return {
      task,
      model: aliasModelId,
      result: null,
      error: error instanceof Error && error.name === 'AbortError' ? 'Subtask timed out (30s)' : getErrorMessage(error),
      latencyMs: Date.now() - start,
      tokensUsed: 0,
    };
  }
}

/**
 * Create the delegate_subtask tool.
 * Each invocation can run up to 3 subtasks in parallel.
 */
export const delegateSubtaskTool = tool({
  description: 'Delegate subtasks to other AI models for parallel processing. Use when a complex request can be broken into independent parts (e.g., "research X while summarizing Y"). Maximum 3 subtasks per call, 30s timeout each.',

  inputSchema: z.object({
    subtasks: z.array(z.object({
      task: z.string().describe('The subtask to complete'),
      // The model reads this on every call, so a wrong statement here is a
      // wrong statement made repeatedly. It named an identifier that does not
      // exist and promised a default the tool never used.
      model: z.string().optional().describe('Optional: which Alia model to use (e.g., "alia-lite", "alia-v1", "alia-v1-pro"). Defaults to alia-v1.'),
      context: z.string().optional().describe('Optional: additional system context for the subtask'),
    })).min(1).max(MAX_CONCURRENT_SUBTASKS).describe('List of subtasks to run in parallel (max 3)'),
  }),

  execute: async ({ subtasks }) => {
    // Enforce limit
    const tasks = subtasks.slice(0, MAX_CONCURRENT_SUBTASKS);

    log.general.info({ count: tasks.length }, 'Delegate: running subtasks in parallel');
    const start = Date.now();

    // Run all subtasks in parallel with Promise.allSettled
    const promises = tasks.map(t =>
      runSubtask(t.task, t.model, t.context)
    );

    const settled = await Promise.allSettled(promises);

    const results: SubtaskResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') {
        return s.value;
      }
      return {
        task: tasks[i].task,
        // Same default as `runSubtask`, for the rejected-promise path.
        model: tasks[i].model || 'alia-v1',
        result: null,
        error: s.reason?.message || 'Subtask failed',
        latencyMs: Date.now() - start,
        tokensUsed: 0,
      };
    });

    const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    const successCount = results.filter(r => r.result !== null).length;

    log.general.info({ succeeded: successCount, total: results.length, totalTokens, latencyMs: Date.now() - start }, 'Delegate: completed');

    return {
      results: results.map(r => ({
        task: r.task,
        model: r.model,
        result: r.result,
        error: r.error,
        latencyMs: r.latencyMs,
      })),
      summary: {
        totalSubtasks: results.length,
        succeeded: successCount,
        failed: results.length - successCount,
        totalLatencyMs: Date.now() - start,
        totalTokensUsed: totalTokens,
      },
    };
  },
});
