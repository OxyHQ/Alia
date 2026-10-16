/**
 * `consultAgent` — the one way an agent is asked something from inside another
 * conversation (Alia ADR 0020 §5). It replaces `askAgent` (the person's own
 * agents) and `delegateToAgent` (the catalogue): both were the same act with two
 * reach rules, and one of them could never reach an app's agent at all.
 *
 * ## Reach is the ordinary rule
 *
 * An agent can be consulted exactly when the person could open it themselves:
 * `canReachAgent` — their own agents, agents shared with them, and public
 * active agents such as Sindi. An agent turn that consults (an agent granted
 * the `agent` family) is narrowed further by its grant's instances when it
 * names any.
 *
 * ## It streams, and the consulted agent JOINS the conversation
 *
 * While it runs the outer stream carries `alia.agent_start`, `agent_delta`,
 * `agent_tool` and `agent_end` (`docs/agent-embedding.md` §4), so the surface
 * draws the agent's reply under its own identity and flies its avatar into the
 * participants header. The tool's result — the agent's full answer — is what
 * the lead reads, and what `stream-runner.ts` persists as that agent's message.
 */
import { randomUUID } from 'node:crypto';
import type { AvatarCharacter } from '@oxy.so/contracts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findAgentById, listActiveAgentsByAuthor } from '../../db/agents/agentRepository.js';
import { canReachAgent } from '../agent-account.js';
import {
  agentPromptName,
  attachAgentIdentity,
  resolveAgentIdentities,
  UNRESOLVED_IDENTITY,
} from '../agent-identity.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import type { SSEEmitter } from '../sse-emitter.js';
import { runAgentTurn, type AgentTurnPerson } from './agent-turn.js';

export const CONSULT_AGENT_TOOL = 'consultAgent';

export interface ConsultAgentResult {
  agentId: string;
  agentName: string;
  agentHandle: string;
  agentColor: string | null;
  agentCharacter: AvatarCharacter | null;
  response: string;
  tokensUsed: number;
  /** What the answer cost the payer. The calling model is told, so it can stop. */
  creditsCharged: number;
  error?: string;
}

export interface ConsultAgentOptions {
  person: AgentTurnPerson;
  /** The account that funds the outer turn, and therefore this one. */
  payerOxyUserId: string;
  /** The agent whose turn this is, which never consults itself. */
  callerAgentId: string | null;
  /** When the caller is an agent with an instanced `agent` grant: the only ids it may consult. */
  allowedAgentIds?: readonly string[];
  /** The outer stream; without one (a channel turn) the consultation still runs, unseen. */
  sseEmitter?: SSEEmitter;
}

function refusal(agentId: string, error: string): ConsultAgentResult {
  return {
    agentId,
    agentName: 'Unknown',
    agentHandle: 'unknown',
    agentColor: null,
    agentCharacter: null,
    response: '',
    tokensUsed: 0,
    creditsCharged: 0,
    error,
  };
}

/** The person's own active agents, named in the tool description so the model can pick one. */
async function ownAgentsLine(options: ConsultAgentOptions): Promise<string> {
  const owned = (await listActiveAgentsByAuthor(getDb(), options.person.oxyUserId)).filter(
    (agent) =>
      agent._id !== options.callerAgentId &&
      (options.allowedAgentIds === undefined || options.allowedAgentIds.includes(agent._id)),
  );
  if (owned.length === 0) return '';
  const identities = await resolveAgentIdentities(owned.map((agent) => agent.oxyAccountId));
  return `\n\nThe person's own agents:\n${owned
    .map(
      (agent) =>
        `- ${agent._id} — ${agentPromptName(identities.get(agent.oxyAccountId) ?? UNRESOLVED_IDENTITY)}: ${agent.tagline}`,
    )
    .join('\n')}`;
}

export async function buildConsultAgentTool(options: ConsultAgentOptions): Promise<ToolSet> {
  if (options.allowedAgentIds !== undefined && options.allowedAgentIds.length === 0) return {};
  const own = await ownAgentsLine(options).catch((error: unknown) => {
    log.general.warn({ err: error }, "Could not list the person's own agents for consultAgent");
    return '';
  });
  const emit = (event: string, data: Record<string, unknown>) => {
    try {
      options.sseEmitter?.emit(event, { eventVersion: 1, ...data });
    } catch (error: unknown) {
      log.general.warn({ err: error, event }, 'Could not emit a consultation event');
    }
  };

  return {
    [CONSULT_AGENT_TOOL]: tool({
      description:
        "Ask another agent — a specialist — to handle something and get its answer. It joins the conversation and answers the person in its own voice, with its own abilities and the person's apps it may use; it cannot see this conversation, so put everything it needs in `task`. " +
        'Find specialists with `searchAgents` (for example Sindi for anything about housing, renting or homes). Do not repeat its answer afterwards; add only what it left out.' +
        own,
      inputSchema: z.object({
        agentId: z.string().min(1).describe('The id of the agent to consult'),
        task: z
          .string()
          .min(1)
          .describe('The question or task, with all the context the agent needs to answer it'),
      }),
      execute: async ({ agentId, task }): Promise<ConsultAgentResult> => {
        try {
          if (
            agentId === options.callerAgentId ||
            (options.allowedAgentIds !== undefined && !options.allowedAgentIds.includes(agentId))
          ) {
            return refusal(agentId, 'That agent is not one you can consult');
          }
          const found = await findAgentById(getDb(), agentId);
          if (
            found === null ||
            (await canReachAgent(found, {
              oxyUserId: options.person.oxyUserId,
              accessToken: options.person.accessToken,
            })) !== 'reachable'
          ) {
            return refusal(agentId, 'Agent not found');
          }
          const agent = await attachAgentIdentity(found);
          const identity = {
            agentId,
            agentName: agentPromptName(agent),
            agentHandle: agent.handle ?? 'unknown',
            agentColor: agent.color,
            agentCharacter: agent.character,
          };
          const consultId = randomUUID();
          emit('alia.agent_start', {
            consultId,
            agent: {
              id: agentId,
              name: identity.agentName,
              handle: identity.agentHandle,
              color: identity.agentColor,
              character: identity.agentCharacter,
            },
            task,
          });
          const outcome = await runAgentTurn({
            agent,
            task,
            person: options.person,
            payerOxyUserId: options.payerOxyUserId,
            observer: {
              onTextDelta: (content) => emit('alia.agent_delta', { consultId, content }),
              onToolCall: ({ toolCallId, name, input }) =>
                emit('alia.agent_tool', { consultId, phase: 'call', toolCallId, name, input }),
              onToolResult: ({ toolCallId, name, output }) =>
                emit('alia.agent_tool', { consultId, phase: 'result', toolCallId, name, output }),
            },
          });
          emit(
            'alia.agent_end',
            outcome.error === undefined
              ? { consultId, status: 'completed', content: outcome.response }
              : { consultId, status: 'failed', error: { code: 'agent_unavailable' } },
          );
          return {
            ...identity,
            response: outcome.response,
            tokensUsed: outcome.tokensUsed,
            creditsCharged: outcome.creditsCharged,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          };
        } catch (error: unknown) {
          log.general.error({ err: error, agentId }, 'consultAgent failed');
          return refusal(agentId, getErrorMessage(error));
        }
      },
    }),
  };
}
