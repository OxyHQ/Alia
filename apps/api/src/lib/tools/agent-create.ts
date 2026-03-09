import { tool } from 'ai';
import { z } from 'zod';
import { Agent } from '../../models/agent.js';
import { log } from '../logger.js';

/**
 * Factory tool for creating AI agents during conversation.
 * Pattern: same as saveUserMemoryTool — closure over userId.
 */
export const createAgentTool = (userId: string, username?: string) => tool({
  description:
    'Create a new AI agent. Use when the user asks to create, build, or make a custom agent, assistant, or specialist. ' +
    'Create immediately with reasonable defaults inferred from the request — do not ask multiple clarifying questions.',

  inputSchema: z.object({
    name: z.string().describe('Agent name (2-4 words, e.g., "Marketing Strategist")'),
    description: z.string().describe('What this agent does and how it should behave (1-3 sentences)'),
    category: z.enum(['Assistant', 'Creative', 'Developer', 'Research', 'Business', 'Education'])
      .optional().default('Assistant')
      .describe('Agent category'),
    systemPrompt: z.string().optional()
      .describe('Detailed system prompt. If omitted, auto-generated from name and description.'),
    capabilities: z.array(z.string()).optional()
      .describe('Tool capabilities: "web-browsing", "web-search", "web-scraping", "code-execution", "file-management", "image-generation", "memory", "agent-delegation"'),
    tags: z.array(z.string()).optional()
      .describe('Tags for discoverability (3-5 lowercase tags)'),
  }),

  execute: async ({ name, description, category, systemPrompt, capabilities, tags }) => {
    try {
      // Generate handle from name (same logic as routes/agents.ts)
      let handle = name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

      // Check uniqueness, append suffix if taken
      const existing = await Agent.findOne({ handle }).select('_id').lean();
      if (existing) {
        handle = `${handle}-${Date.now().toString(36).slice(-4)}`;
      }

      // Auto-generate tagline from first sentence of description
      const tagline = description.split(/[.!?]/)[0].trim().slice(0, 100) || description.slice(0, 100);

      // Auto-generate system prompt if not provided
      const finalSystemPrompt = systemPrompt || `You are ${name}. ${description}`;

      const agent = await Agent.create({
        name,
        handle,
        tagline,
        description,
        author: userId,
        authorName: username || 'Unknown',
        authorVerified: false,
        category: category || 'Assistant',
        tags: tags || [],
        capabilities: capabilities || [],
        isPublished: true,
        systemPrompt: finalSystemPrompt,
        allowedModels: ['alia-v1', 'alia-v1-pro'],
      });

      log.general.info({ agentId: agent._id, handle, userId }, 'Agent created via tool');

      return {
        success: true,
        agent: {
          id: agent._id.toString(),
          name: agent.name,
          handle: agent.handle,
          tagline: agent.tagline,
          category: agent.category,
        },
        message: `Agent "${name}" created successfully! Handle: @${handle}`,
      };
    } catch (error: any) {
      log.general.error({ err: error }, 'Agent creation via tool failed');
      return { success: false, error: error.message || 'Failed to create agent' };
    }
  },
});
