/**
 * Agent Search Tool
 * Allows Alia to search for published, active agents that can help with the user's task.
 *
 * Only agents that open where the person is: an agent Oxy confines to an app is
 * not offered outside it (ADR 0021), and one whose answer Oxy could not give is
 * left out rather than offered.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { searchActiveAgents } from '../../db/agents/agentRepository.js';
import { agentOpensOn } from '../agent-availability.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const MAX_RESULTS = 10;

/** @param surfaceApplicationId the app the person is in (`lib/app-surface.ts`), or `null` */
export const createSearchAgentsTool = (surfaceApplicationId: string | null) =>
  tool({
    description:
      'Find specialist agents for a task (tagline, category, tags). If none fits, handle the task yourself.',

    inputSchema: z.object({
      query: z
        .string()
        .describe('Search query describing what kind of agent or task you need help with'),
    }),

    execute: async ({ query }) => {
      try {
        const found = await searchActiveAgents(getDb(), query, MAX_RESULTS);
        const opens = await Promise.all(
          found.map((agent) => agentOpensOn(agent.oxyAccountId, surfaceApplicationId)),
        );
        const agents = found.filter((_agent, index) => opens[index] === 'reachable');

        // The query is model output derived from the user's prompt.
        log.general.info({ resultCount: agents.length }, 'Agent search completed');

        return { agents, count: agents.length };
      } catch (error: unknown) {
        log.general.error({ err: error }, 'Agent search failed');
        return { agents: [], count: 0, error: getErrorMessage(error) };
      }
    },
  });
