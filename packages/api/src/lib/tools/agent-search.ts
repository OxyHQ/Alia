/**
 * Agent Search Tool
 * Allows Alia to search for published, active agents that can help with the user's task.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { searchActiveAgents } from '../../db/agents/agentRepository.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const MAX_RESULTS = 10;

export const createSearchAgentsTool = () => tool({
  description: 'Search for available AI agents that can help with a specific task. Returns a list of matching agents with their capabilities. Use this when agent mode is active to find specialists.',

  inputSchema: z.object({
    query: z.string().describe('Search query describing what kind of agent or task you need help with'),
  }),

  execute: async ({ query }) => {
    try {
      const agents = await searchActiveAgents(getDb(), query, MAX_RESULTS);

      // The query is model output derived from the user's prompt.
      log.general.info({ resultCount: agents.length }, 'Agent search completed');

      return { agents, count: agents.length };
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Agent search failed');
      return { agents: [], count: 0, error: getErrorMessage(error) };
    }
  },
});
