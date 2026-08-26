/**
 * `askAgent` — the owner's OWN agents, talking to each other.
 *
 * Separate from `delegateToAgent` on purpose, and the difference is not the
 * verb. That one searches the CATALOGUE and hands work to a specialist somebody
 * else published; this one reaches the agents you already have, and is granted
 * by naming them. Folding the two together would mean one grant answering two
 * questions — "may it hire strangers" and "may it talk to my other agents" —
 * which is the kind of overloaded switch `domain/capability-grants.ts` exists to
 * end.
 *
 * ## One tool, not one tool per agent
 *
 * The `agent` family is instanced, so the obvious shape is a tool per granted
 * agent. It would have to take its NAME from the agent's handle, and a handle is
 * Oxy's, editable, and not unique to this list — so the tool set would change
 * shape when somebody renamed an account, and two agents could collide into one
 * name. Naming by convention is what this repository has already removed twice.
 *
 * Instead the grant decides the tool's SCHEMA: `agentId` is a `z.enum` of
 * exactly the agents this turn may reach, so the model cannot name another one,
 * and the description carries each agent's name and tagline so it can choose.
 * The tool is not built at all when the selection resolves to none.
 *
 * ## The enum is an affordance; the CHECK is in `execute`
 *
 * A schema is not an authorization boundary — `lib/chat/text-tool-fallback.ts`
 * parses tool calls out of TEXT for models that cannot emit them, so an id can
 * reach `execute` without ever passing through the enum. Two things are
 * therefore re-checked at call time, and neither of them trusts the client or
 * the model:
 *
 *  - the id is in the allow-list this turn RESOLVED, which lives in the closure
 *    and was built from the owner's own rows; and
 *  - the row still belongs to the same owner and is still `active`, read again
 *    from the database, because an agent can be reassigned or switched off
 *    between the moment the tool was built and the moment it is called.
 *
 * The same invariant the composer's `mcpServerId` carries: an id that arrives
 * from outside is re-checked for ownership and runnable state in the API. An
 * agent that can name another's id still cannot talk to it.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { getDb } from '../../db/index.js';
import {
  findAgentById,
  listActiveAgentsByAuthor,
  type GrantableAgent,
} from '../../db/agents/agentRepository.js';
import {
  agentPromptName,
  attachAgentIdentity,
  resolveAgentIdentities,
  UNRESOLVED_IDENTITY,
} from '../agent-identity.js';
import { runAgentTurn } from './agent-turn.js';
import { log } from '../logger.js';

export interface AskAgentResult {
  agentId: string;
  agentName: string;
  /**
   * The answering agent's handle and colour, for the glyph a client draws.
   *
   * Here because `lib/chat/stream-runner.ts` unpacks this result into an
   * `alia.agent` SSE frame, exactly as it does a delegation's: both are another
   * agent speaking, and a client cannot draw one of them without an identity.
   */
  agentHandle: string;
  agentColor: string | null;
  response: string;
  tokensUsed: number;
  /** What the answer cost the payer. The calling model is told, so it can stop. */
  creditsCharged: number;
  error?: string;
}

/** One agent this turn may reach, with the name the model chooses by. */
interface ReachableAgent extends GrantableAgent {
  name: string;
}

/**
 * Build `askAgent` for one turn, over the agents the grant resolves to.
 *
 * @param ownerOxyUserId The account this turn acts for. It scopes the rows AND
 *   pays for what the tool spends — one subject, fixed here, before anything is
 *   reserved.
 * @param selection The granted ids, or `undefined` for "every active agent",
 *   which is what a bare `agent` grant means. An EMPTY array is "none granted"
 *   and short-circuits without touching the database, exactly as the three
 *   connector sources do.
 * @param callerAgentId The agent whose turn this is, excluded from its own list:
 *   an agent asking itself is a loop with a bill attached.
 */
export async function buildAskAgentTool(
  ownerOxyUserId: string,
  selection: readonly string[] | undefined,
  callerAgentId: string | null,
): Promise<ToolSet> {
  if (selection !== undefined && selection.length === 0) return {};

  const owned = await listActiveAgentsByAuthor(getDb(), ownerOxyUserId);
  const chosen = owned.filter(
    (candidate) =>
      candidate._id !== callerAgentId &&
      (selection === undefined || selection.includes(candidate._id)),
  );
  if (chosen.length === 0) return {};

  /**
   * ONE batch call for every name, and it fails open: an account Oxy cannot
   * resolve keeps its row, under the generic name `agentPromptName` gives. The
   * tagline is Alia's own and identifies the agent either way, so an identity
   * service having a bad afternoon must not remove agents from a grant the
   * owner made.
   */
  const identities = await resolveAgentIdentities(chosen.map((agent) => agent.oxyAccountId));
  const reachable: ReachableAgent[] = chosen.map((agent) => ({
    ...agent,
    name: agentPromptName(identities.get(agent.oxyAccountId) ?? UNRESOLVED_IDENTITY),
  }));

  const allowed = new Map(reachable.map((agent) => [agent._id, agent]));
  const [first, ...rest] = reachable.map((agent) => agent._id);

  return {
    askAgent: tool({
      description:
        'Ask one of the user\'s own agents a question and get its answer back. ' +
        'The agent answers with its own instructions and its own capabilities, and it ' +
        'cannot see this conversation — so include every detail it needs in `message`. ' +
        'Use this to consult a specialist the user already has, NOT to hire one from the ' +
        'catalogue.\n\nAgents you can reach:\n' +
        reachable.map((agent) => `- ${agent._id} — ${agent.name}: ${agent.tagline}`).join('\n'),

      inputSchema: z.object({
        agentId: z.enum([first, ...rest]).describe('The id of the agent to ask, from the list above'),
        message: z
          .string()
          .describe('The question or task, with all the context the agent needs to answer it'),
      }),

      execute: async ({ agentId, message }): Promise<AskAgentResult> => {
        const listed = allowed.get(agentId);
        if (!listed) {
          // Not an error worth logging as a failure: a model naming an agent it
          // was not given is the schema doing its job, and the answer tells it so.
          return {
            agentId,
            agentName: 'Unknown',
            agentHandle: 'unknown',
            agentColor: null,
            response: '',
            tokensUsed: 0,
            creditsCharged: 0,
            error: 'That agent is not one you can reach',
          };
        }

        /**
         * Read back, rather than trusting the list built at the top of the turn.
         * Ownership and `status` are both re-asked: a row can move or be
         * switched off while the model is still deciding to call this.
         */
        const found = await findAgentById(getDb(), agentId);
        if (!found || found.author !== ownerOxyUserId || found.status !== 'active') {
          log.agents.info(
            { agentId, ownerOxyUserId },
            'askAgent refused: the agent is no longer reachable for this owner',
          );
          return {
            agentId,
            agentName: listed.name,
            agentHandle: 'unknown',
            agentColor: null,
            response: '',
            tokensUsed: 0,
            creditsCharged: 0,
            error: 'That agent is no longer active',
          };
        }

        const agent = await attachAgentIdentity(found);
        const outcome = await runAgentTurn({ agent, task: message, payerOxyUserId: ownerOxyUserId });

        return {
          agentId,
          agentName: agentPromptName(agent),
          agentHandle: agent.handle ?? 'unknown',
          agentColor: agent.color,
          response: outcome.response,
          tokensUsed: outcome.tokensUsed,
          creditsCharged: outcome.creditsCharged,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        };
      },
    }),
  };
}
