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
      'Run a thorough multi-source research on a topic. Use this when the user asks for deep research, ' +
      'comprehensive analysis, or when the question requires consulting multiple web sources for an accurate, ' +
      'well-cited answer. Returns a detailed report with inline citations and references.',
    inputSchema: z.object({
      query: z.string().describe('The research question or topic to investigate thoroughly'),
    }),
    execute: async ({ query }) => {
      log.tools.info({ query }, 'Deep research tool invoked by AI');

      try {
        const result = await runDeepResearch(query, [], {
          userId,
          onProgress: () => {}, // Progress streaming handled at route level
        });

        return {
          report: result.report,
          sources: result.sources,
          subQuestions: result.subQuestions,
          totalSearches: result.totalSearches,
        };
      } catch (err: unknown) {
        log.tools.error({ err, query }, 'Deep research tool failed');
        return { error: `Research failed: ${getErrorMessage(err)}` };
      }
    },
  });
}
