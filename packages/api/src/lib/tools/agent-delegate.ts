/**
 * Agent Delegation Tool
 * Allows Alia to delegate a task to a specific agent and get its response.
 *
 * - Looks up the agent from the DB and asks whether this caller may REACH it
 * - Runs it through `runAgentTurn`, which builds its prompt, assembles its tools
 *   under ITS OWN grants, and bills the caller's account for the nested turn
 * - Returns the agent's response with identity metadata
 *
 * ## The agent id was not authorised at all, and that is data of somebody else's
 *
 * `findAgentById` on its own: no `access`, no `status`, no owner. An id is a
 * `randomUUID()`, but nothing else stood between one and running a STRANGER'S
 * PRIVATE DRAFT — and running an agent is reading it. Its `systemPrompt` is the
 * thing its owner actually wrote, and the answer that comes back is that prompt
 * applied to a task the caller chose; a draft can be characterised, and its
 * instructions can be talked out of it, without the text ever being served.
 * `GET /agents/:id` closed the same hole from the other side by withholding the
 * prompt from anyone who may not edit the agent.
 *
 * The gate is {@link canReachAgent} — the SAME one `loadTurnAgent` applies to
 * the `agentId` a client sends, and for the same reason: this id is model output
 * derived from `searchAgents`, so it is untrusted input on a path that has a
 * caller identity to check it against. Not a hand-written `is_published &&
 * status` pair here, which is the shape that drifts from the product's answer
 * one surface at a time.
 *
 * A refusal is the SAME `Agent not found` as a missing row. Distinguishing them
 * would confirm that an id exists, which is exactly what a private draft must
 * not tell a stranger who guessed one — the argument `loadThreadAgent` makes for
 * collapsing every refusal into `null`.
 *
 * ## The tool set was a hand-written literal, and it ignored the delegate
 *
 * `{ getCurrentDate, webScraper }`, inline, handed straight to `generateText`.
 * Two things were wrong with it and only the second is about tidiness: it gave
 * the delegate a WEB SCRAPER whatever its owner had granted, so a delegation was
 * a way around the agent's own capabilities; and it was a sixth construction of
 * a tool set, invisible to `__tests__/one-assembler.test.ts` because it carried
 * no `ToolSet` annotation for the census to find.
 *
 * ## And the turn was FREE, which is the other half of the same collapse
 *
 * Running the delegate reserved nothing, and no reservation upstream covered it
 * either — see `agent-turn.ts`, which now owns the whole nested-turn shape for
 * this tool and for `askAgent`. The behaviour change is stated rather than
 * buried: a delegation costs the delegating account credits, as any other
 * inference it asks for does.
 *
 * The delegating USER pays, which is why this factory takes a `userId` it never
 * hands to the model. The subject is fixed when the tool is built, before the
 * model has decided anything.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { canReachAgent } from '../agent-account.js';
import { runAgentTurn } from './agent-turn.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

export interface AgentDelegationResult {
  agentId: string;
  agentName: string;
  agentHandle: string;
  /** The agent's Bloom colour preset key, for the glyph a client draws. */
  agentColor: string | null;
  response: string;
  tokensUsed: number;
  error?: string;
}

/**
 * @param userId The account the delegation is billed to, and the caller whose
 *   standing decides which agents are reachable: whoever's turn this is.
 * @param accessToken That caller's own bearer. Absent, a private agent is
 *   unreachable rather than reachable — `canReachAgent` fails closed, and the
 *   assembler only builds this tool for a turn that holds a session.
 */
export const createDelegateToAgentTool = (userId: string, accessToken: string | undefined) => tool({
  description: 'Delegate a task to a specific agent by ID. The agent will autonomously process the task and return its response. Use after searchAgents to delegate work to the best-matching agent.',

  inputSchema: z.object({
    agentId: z.string().describe('The ID of the agent to delegate to (from searchAgents results)'),
    task: z.string().describe('The task or question to send to the agent. Be specific and provide full context.'),
  }),

  execute: async ({ agentId, task }): Promise<AgentDelegationResult> => {
    try {
      // Look up the agent, then its identity: the delegation result carries the
      // agent's name, handle and colour for the client to render, and all three
      // are the bot account's.
      const found = await findAgentById(getDb(), agentId);
      /**
       * One answer for both refusals. `canReachAgent` is public-and-active, or
       * standing in the bot account — an owner's own agent, or one shared with
       * them by being added to it.
       */
      if (found === null || !(await canReachAgent(found, { oxyUserId: userId, accessToken }))) {
        if (found !== null) {
          log.general.info({ agentId, userId }, 'Delegation refused: the caller cannot reach that agent');
        }
        return {
          agentId,
          agentName: 'Unknown',
          agentHandle: 'unknown',
          agentColor: null,
          response: '',
          tokensUsed: 0,
          error: 'Agent not found',
        };
      }

      const agent = await attachAgentIdentity(found);
      const outcome = await runAgentTurn({ agent, task, payerOxyUserId: userId });

      return {
        agentId,
        agentName: agentPromptName(agent),
        agentHandle: agent.handle ?? 'unknown',
        agentColor: agent.color,
        response: outcome.response,
        tokensUsed: outcome.tokensUsed,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
    } catch (error: unknown) {
      log.general.error({ err: error, agentId }, 'Agent delegation failed');
      return {
        agentId,
        agentName: 'Unknown',
        agentHandle: 'unknown',
        agentColor: null,
        response: '',
        tokensUsed: 0,
        error: getErrorMessage(error),
      };
    }
  },
});
