import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAgent } from '../../db/agents/agentRepository.js';
import { createAgentBotAccount } from '../agent-account.js';
import { fallbackAgentUsername, suggestAgentUsername } from '../agent-identity.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { FIXED_CAPABILITY_FAMILIES } from '../../domain/capability-grants.js';
import { AGENT_COLORS, agentColorFor } from '../../domain/agent-color.js';
import { accountCategoryChoices, isOfferedAccountCategory } from '../account-category.js';

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
    /**
     * The same ask as `POST /agents/generate`, in the same words.
     *
     * This said "2-4 words, e.g. Marketing Strategist" — a POST, not somebody,
     * and the exact example the other door now rules out. An agent that arrives
     * called Nadia through one door and Marketing Strategist through the other
     * is one product with two naming conventions, decided by a detail nobody
     * remembers choosing.
     */
    name: z.string().describe(
      'A GIVEN NAME for the agent, as you would name a person — "Claudio", "Nadia", "Bruno", ' +
        '"Xiomara". Never a job title: not "Community Manager", not "Support Bot". Prefer the ' +
        'distinctive over the ordinary. One or two words.',
    ),
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
          'agent gets NOTHING it was not granted. The four row-at-a-time families ' +
          "(MCP connectors, Oxy services, integrations, and the owner's own agents) " +
          'are granted a row at a time in the agent editor and cannot be chosen here.',
      ),
    tags: z.array(z.string()).optional()
      .describe('Tags for discoverability (3-5 lowercase tags)'),
    /**
     * Free text, so it is described rather than enumerated — the offered ids
     * are checked in `execute`, because a model asked for a closed vocabulary
     * invents plausible members of it.
     */
    accountCategory: z.string().optional()
      .describe(
        `What the agent is ABOUT, for its account in the wider Oxy graph. Exactly one of: ` +
          `${accountCategoryChoices}. This is the SUBJECT and "category" above is the KIND of ` +
          `agent: answer each on its own, they need not agree. Omit it entirely if none fits — ` +
          `no category is better than a wrong one.`,
      ),
    color: z.enum(AGENT_COLORS).optional()
      .describe(
        'The agent has no picture — it is drawn as a glyph in this colour — so pick the one ' +
          'that suits what it does.',
      ),
  }),

  execute: async ({ name, description, category, systemPrompt, capabilityGrants, tags, accountCategory, color }) => {
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

      /**
       * The seeded prompt describes the agent and does NOT name it.
       *
       * It used to be `You are ${name}. ${description}`, and the name in it is a
       * COPY: `name` is also sent to Oxy as the bot account's `displayName`,
       * which is where `agentPromptName` reads the agent's name from on every
       * turn thereafter. The two are equal for exactly as long as nobody renames
       * the agent — and the agent editor renames it,
       * `app/(app)/agents/edit/[id].tsx` calling `updateAccount` with a new
       * `name.displayName`.
       *
       * After a rename the identity guard says "You are Pepe", read live from
       * Oxy, and the `# AGENT: Pepe` section under it says "You are Claudio",
       * read from a column written months earlier. That is precisely the
       * two-owners contradiction `#453` removed from the prompt files, frozen
       * into a row instead of a markdown file.
       *
       * The description alone is the right seed: the guard owns the NAME and
       * this section owns what the agent is FOR, which is the split the guard's
       * remit rule already cites. Nothing is lost — the name was never carrying
       * information the composed message did not already have, twice.
       *
       * Rows already written keep their frozen name. Rewriting somebody's own
       * editable prompt is not this change's to make.
       */
      const finalSystemPrompt = systemPrompt || description;

      const username = suggestAgentUsername(name) ?? fallbackAgentUsername();

      const account = await createAgentBotAccount({
        accessToken,
        username,
        displayName: name,
        bio: tagline,
        /**
         * Derived from the handle when the model offered nothing, exactly as the
         * other door does: asking twice for the same agent proposes the same
         * colour. Omitting it entirely is not neutral — Oxy assigns a RANDOM
         * preset — so "no colour" is not a state this can reach anyway, and a
         * colour chosen for what the agent does beats one chosen by nobody.
         *
         * Not re-validated here, unlike `accountCategory` below: `AGENT_COLORS`
         * is a tuple, so the schema can ENUMERATE it and the tool call is
         * refused before `execute` runs. The category's vocabulary is a
         * `readonly` array the schema cannot enumerate, which is exactly why
         * that one is checked in code and this one is not.
         */
        color: color ?? agentColorFor(username),
        /**
         * Dropped rather than corrected when the taxonomy does not recognise
         * it, and OMITTED rather than sent empty: absent means "no categories"
         * and `[]` means "clear them", which are different requests.
         */
        ...(isOfferedAccountCategory(accountCategory)
          ? { accountCategories: [accountCategory] }
          : {}),
      });

      const agent = await createAgent(getDb(), {
        oxyAccountId: account.oxyAccountId,
        // `createAgentBotAccount` omitted a parent, so Oxy created the bot
        // directly under this caller's personal account. Store that authority
        // explicitly; `author` remains listing metadata only.
        ownerOxyAccountId: userId,
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
        allowedModels: ['kaana-v1', 'kaana-v1-pro'],
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
