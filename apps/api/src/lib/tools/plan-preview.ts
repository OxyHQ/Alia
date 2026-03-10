/**
 * Plan Preview Tool
 *
 * Lets the AI show users a structured plan before executing multi-step tasks.
 * Follows the same SSE callback pattern as switchModel.
 */

import { tool } from 'ai';
import { z } from 'zod';

export interface PlanStep {
  action: string;
  description: string;
  toolName?: string;
}

/**
 * Create a planPreview tool.
 * @param onPlan Callback fired when the AI generates a plan — use to send SSE event.
 */
export function createPlanPreviewTool(onPlan: (steps: PlanStep[]) => void) {
  return tool({
    description:
      'Show the user a step-by-step plan before executing a multi-step task. ' +
      'Use when a task requires 3 or more tool calls. ' +
      'Do NOT use for simple questions, greetings, or single-step tasks.',
    inputSchema: z.object({
      steps: z.array(z.object({
        action: z.string().describe('Short action label, e.g. "Search the web"'),
        description: z.string().describe('One-sentence explanation of this step'),
        toolName: z.string().optional().describe('Tool name if applicable'),
      })).describe('Ordered list of planned steps'),
    }),
    execute: async ({ steps }) => {
      onPlan(steps as PlanStep[]);
      return { shown: true, stepCount: steps.length };
    },
  });
}
