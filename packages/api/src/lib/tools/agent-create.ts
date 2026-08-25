import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAgent } from '../../db/agents/agentRepository.js';
import { createAgentBotAccount } from '../agent-account.js';
import { fallbackAgentUsername, suggestAgentUsername } from '../agent-identity.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { FIXED_CAPABILITY_FAMILIES } from '../../domain/capability-grants.js';

/**
 * Factory tool for creating AI agents during conversation.
 * Pattern: same as saveUserMemoryTool — closure over userId.
 *
 * ## It takes the caller's BEARER, not their username
 *
 * An agent IS an Oxy `bot` account now, so creating one starts at Oxy — with
 * the user's own credential, because the account is minted under THEIR tree and
 * they become its owner. The `username` this used to close over was written
 * into a `author_name` column that no longer exists, and was `'Unknown'` on
 * nearly every row besides: `req.user` carries only `{ id }` unless the auth
 * middleware was asked to load the profile, which it never was here.
 *
 * The account is minted BEFORE the row, and nothing rolls it back if the row
 * fails. That is the honest ordering: `agents.oxy_account_id` is `notNull`, so
 * the row cannot exist first, and an orphaned bot account is a harmless empty
 * account its owner can archive — whereas an agent row pointing at an account
 * that was never created is a listing that can never render.
 */
export const createAgentTool = (userId: string, accessToken: string | undefined) => tool({
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
    capabilityGrants: z
      .array(z.enum(FIXED_CAPABILITY_FAMILIES))
      .optional()
      .describe(
        'What the agent may reach. Pick only the families its purpose needs — an ' +
          'agent gets NOTHING it was not granted. The three instanced families ' +
          '(MCP connectors, Oxy services, integrations) are granted per connector ' +
          'in the agent editor and cannot be chosen here.',
      ),
    tags: z.array(z.string()).optional()
      .describe('Tags for discoverability (3-5 lowercase tags)'),
  }),

  execute: async ({ name, description, category, systemPrompt, capabilityGrants, tags }) => {
    try {
      if (accessToken === undefined) {
        // An API-key turn has no user bearer, so it cannot mint an account
        // under anybody's tree. Refused in words the model can relay rather
        // than thrown, which would end the turn.
        return {
          success: false,
          error: 'Creating an agent requires a signed-in session.',
        };
      }

      // Auto-generate tagline from first sentence of description
      const tagline = description.split(/[.!?]/)[0].trim().slice(0, 100) || description.slice(0, 100);

      // Auto-generate system prompt if not provided
      const finalSystemPrompt = systemPrompt || `You are ${name}. ${description}`;

      const account = await createAgentBotAccount({
        accessToken,
        username: suggestAgentUsername(name) ?? fallbackAgentUsername(),
        displayName: name,
        bio: tagline,
      });

      const agent = await createAgent(getDb(), {
        oxyAccountId: account.oxyAccountId,
        tagline,
        description,
        authorOxyUserId: userId,
        category: category || 'Assistant',
        tags: tags || [],
        capabilityGrants: capabilityGrants ?? [],
        isPublished: true,
        systemPrompt: finalSystemPrompt,
        // Restated rather than left to the column default, because the source
        // stated it: an agent built by this tool is pinned to these two whatever
        // the default becomes.
        allowedModels: ['alia-v1', 'alia-v1-pro'],
      });

      log.general.info(
        { agentId: agent._id, username: account.username, userId },
        'Agent created via tool',
      );

      return {
        success: true,
        agent: {
          id: agent._id,
          name,
          handle: account.username,
          tagline: agent.tagline,
          category: agent.category,
        },
        message: `Agent "${name}" created successfully! Handle: @${account.username}`,
      };
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Agent creation via tool failed');
      return { success: false, error: getErrorMessage(error) };
    }
  },
});
