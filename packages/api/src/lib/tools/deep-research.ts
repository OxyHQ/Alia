/**
 * Deep Research Tool
 *
 * An AI-callable tool that triggers the deep research engine.
 * The AI decides when a question needs thorough multi-source research
 * and calls this tool instead of answering from general knowledge.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { runDeepResearch } from '../research/research-engine.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

/**
 * Create a deep research tool bound to a specific user ID.
 * The tool runs the multi-step research engine: decompose → search → extract → synthesize.
 */
export function createDeepResearchTool(userId: string) {
  return tool({
    description:
      'Thorough multi-source web research, returned as a report with inline citations. Use it when the user asks for deep research or comprehensive analysis, or the question needs several sources.',
    inputSchema: z.object({
      query: z.string().describe('The research question or topic'),
    }),
    execute: async ({ query }) => {
      // The research question is the user's own prompt, restated by the model.
      log.tools.info({ queryLength: query.length }, 'Deep research tool invoked by AI');

      try {
        const result = await runDeepResearch(query, [], {
          userId,
          onProgress: () => {}, // Progress streaming handled at route level
        });

        // The same shape the research-mode handler persists as a
        // `deepResearch` invocation (`lib/chat-modes/deep-research-handler.ts`),
        // plus the report, which there is the message itself. `status` is
        // `'partial'` when the write-up failed and `report` is the note that
        // says so — the model reading this result must not present it as done.
        return {
          status: result.status,
          report: result.report,
          sources: result.sources,
          subQuestions: result.subQuestions,
          totalSearches: result.totalSearches,
          findingsSummary: result.findingsSummary,
        };
      } catch (err: unknown) {
        log.tools.error({ err, queryLength: query.length }, 'Deep research tool failed');
        return { error: `Research failed: ${getErrorMessage(err)}` };
      }
    },
  });
}
