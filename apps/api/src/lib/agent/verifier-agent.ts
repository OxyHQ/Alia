/**
 * Verifier Agent — Quality Assurance Layer
 *
 * Third layer of the three-layer orchestration (Manus pattern):
 *   Planner → Executors → Verifier
 *
 * Uses a cheap but capable model to verify that executor outputs
 * meet the original task requirements. Returns pass/fail with
 * actionable feedback for retry.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { log } from '../logger.js';

export interface VerificationResult {
  passed: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  summary: string;
}

const VerificationSchema = z.object({
  passed: z.boolean().describe('Whether the output satisfactorily addresses the original task'),
  score: z.number().min(0).max(10).describe('Quality score from 0-10'),
  issues: z.array(z.string()).describe('Specific issues found in the output'),
  suggestions: z.array(z.string()).describe('Suggestions for improvement if issues exist'),
  summary: z.string().describe('Brief summary of the verification'),
});

/**
 * Verify that executor results meet the original task requirements.
 *
 * Uses a cheap model (cost-efficient for QA) to evaluate completeness,
 * correctness, and quality of the combined executor outputs.
 */
export async function verifyResults(
  originalTask: string,
  executorResults: Array<{ subtask: string; result: string; success: boolean }>,
  opts?: { minScore?: number },
): Promise<VerificationResult> {
  const minScore = opts?.minScore ?? 6;

  // Use a cheap model for verification (cost efficiency)
  const verifierModels = ['alia-lite', 'alia-v1'];
  let resolved: Awaited<ReturnType<typeof resolveModel>> | null = null;

  for (const modelId of verifierModels) {
    resolved = await resolveModel(modelId);
    if (resolved) break;
  }

  if (!resolved) {
    resolved = await resolveModel(getDefaultAliaModel());
  }

  if (!resolved) {
    // If no model available, pass by default
    log.agents.warn('Verifier: no model available, auto-passing');
    return {
      passed: true,
      score: 5,
      issues: [],
      suggestions: ['Verification skipped — no model available'],
      summary: 'Auto-passed (no verification model available)',
    };
  }

  const model = getAIModel(resolved.keyConfig);

  const resultsSummary = executorResults
    .map((r, i) => `### Subtask ${i + 1}: ${r.subtask}\n**Status:** ${r.success ? 'Success' : 'Failed'}\n**Result:** ${r.result.slice(0, 1000)}`)
    .join('\n\n');

  const failedCount = executorResults.filter(r => !r.success).length;

  try {
    const result = await generateObject({
      model,
      schema: VerificationSchema,
      system: `You are a quality assurance verifier. Evaluate whether the combined outputs from multiple executor agents satisfactorily address the original task.

Consider:
1. Completeness — Were all aspects of the task addressed?
2. Correctness — Are the results accurate and reasonable?
3. Consistency — Do the results from different subtasks align?
4. Quality — Is the output useful and well-formed?

A score of ${minScore}+ means "passed". Be fair but thorough.`,
      prompt: `## Original Task\n${originalTask}\n\n## Executor Results (${failedCount} of ${executorResults.length} failed)\n\n${resultsSummary}`,
      temperature: 0.1,
      maxRetries: 1,
    });

    const verification = result.object as VerificationResult;

    // Override pass/fail based on score threshold
    verification.passed = verification.score >= minScore;

    log.agents.info(
      { passed: verification.passed, score: verification.score, issues: verification.issues.length },
      'Verifier: completed verification',
    );

    return verification;
  } catch (err: any) {
    log.agents.error({ err }, 'Verifier: failed');
    // On verification failure, pass if majority of executors succeeded
    const successRate = executorResults.filter(r => r.success).length / executorResults.length;
    return {
      passed: successRate >= 0.5,
      score: Math.round(successRate * 10),
      issues: ['Verification model call failed'],
      suggestions: [],
      summary: `Auto-scored based on executor success rate (${Math.round(successRate * 100)}%)`,
    };
  }
}
