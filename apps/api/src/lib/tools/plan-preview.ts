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
      'Show the user a step-by-step plan ONLY when the task will require calling 3+ other tools (e.g. web search → file generation → follow-up search). ' +
      'NEVER use for: greetings, simple questions, brainstorming, creative writing, conversations, advice, explanations, single-tool tasks, or any request you can answer directly. ' +
      'When in doubt, do NOT show a plan — just respond.',
    inputSchema: z.object({
      steps: z.array(z.object({
        action: z.string().min(1).describe('Short action label, e.g. "Search the web"'),
        description: z.string().min(1).describe('One-sentence explanation of this step'),
        toolName: z.string().optional().describe('Tool name if applicable'),
      })).min(2).describe('Ordered list of planned steps (minimum 2)'),
    }),
    execute: async ({ steps }) => {
      // Filter out steps with blank/whitespace-only actions
      const valid = steps.filter((s) => s.action.trim() && s.description.trim()) as PlanStep[];
      if (valid.length < 2) {
        return { shown: false, reason: 'Not enough valid steps to show a plan. Just respond directly.' };
      }
      onPlan(valid);
      return { shown: true, stepCount: valid.length };
    },
  });
}
