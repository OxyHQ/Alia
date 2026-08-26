/**
 * Agent Delegation Tool
 * Allows Alia to delegate a task to a specific agent and get its response.
 *
 * - Looks up the agent from the DB
 * - Runs it through `runAgentTurn`, which builds its prompt, assembles its tools
 *   under ITS OWN grants, and bills the caller's account for the nested turn
 * - Returns the agent's response with identity metadata
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
 * @param userId The account the delegation is billed to: whoever's turn is
 *   calling the tool.
 */
export const createDelegateToAgentTool = (userId: string) => tool({
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
      if (!found) {
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
