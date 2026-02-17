/**
 * Agent Search Tool
 * Allows Alia to search for published, active agents that can help with the user's task.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { Agent } from '../../models/agent.js';
import { log } from '../logger.js';

const MAX_RESULTS = 10;

export const createSearchAgentsTool = () => tool({
  description: 'Search for available AI agents that can help with a specific task. Returns a list of matching agents with their capabilities. Use this when agent mode is active to find specialists.',

  inputSchema: z.object({
    query: z.string().describe('Search query describing what kind of agent or task you need help with'),
  }),

  execute: async ({ query }) => {
    try {
      // Build regex for flexible matching across multiple fields
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const words = escapedQuery.split(/\s+/).filter(Boolean);
      const regexPattern = words.map(w => `(?=.*${w})`).join('') + '.*';
      const regex = new RegExp(regexPattern, 'i');

      const agents = await Agent.find({
        isPublished: true,
        status: 'active',
        $or: [
          { name: regex },
          { handle: regex },
          { tagline: regex },
          { description: regex },
          { category: regex },
          { tags: { $in: words.map(w => new RegExp(w, 'i')) } },
          { capabilities: { $in: words.map(w => new RegExp(w, 'i')) } },
        ],
      })
        .select('name handle avatar tagline category capabilities')
        .limit(MAX_RESULTS)
        .lean();

      log.general.info({ query, resultCount: agents.length }, 'Agent search completed');

      return {
        agents: agents.map((a: any) => ({
          id: a._id.toString(),
          name: a.name,
          handle: a.handle,
          avatar: a.avatar,
          tagline: a.tagline,
          category: a.category,
          capabilities: a.capabilities || [],
        })),
        count: agents.length,
      };
    } catch (error: any) {
      log.general.error({ err: error, query }, 'Agent search failed');
      return { agents: [], count: 0, error: error.message };
    }
  },
});
