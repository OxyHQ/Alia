/**
 * Editing an agent: the one place the write is made, for the HTTP route and for Alia's own tool.
 *
 * `PATCH /agents/:id` and the `updateAgent` tool are two doors to the same act, so what happens
 * behind them is written once: who may edit (anyone who may act as the bot account), the look set
 * on the Oxy account first (so a refusal leaves the agent as it was), the row written from DEFINED
 * keys only, and the answer in the shape `GET /agents/:id` has, child lists attached (the client
 * writes it straight into its cache, and a shape without them used to wipe them on the next save).
 *
 * What a door adds is its own: the route validates the wire body and answers HTTP; the tool
 * answers in words the model can relay.
 */

import { resolveModel } from './chat-core.js';
import { ModelNotFoundError } from './models/errors.js';
import { getDb } from '../db/index.js';
import {
  type AgentRecord,
  findAgentKnowledge,
  findAgentSkills,
  type UpdateAgentInput,
  updateAgent,
  withoutInternalAgentBindings,
} from '../db/agents/agentRepository.js';
import {
  type AgentAccountRefusal,
  loadAgentForActor,
  refusalMessage,
  refusalStatus,
  setAgentAccountCharacter,
  setAgentAccountName,
} from './agent-account.js';
import { attachAgentIdentity } from './agent-identity.js';
import { log } from './logger.js';

/** The agent's own record plus the two child lists `populate` used to attach. */
export async function withChildLists(agent: AgentRecord): Promise<AgentRecord> {
  const [skills, knowledge] = await Promise.all([
    findAgentSkills(getDb(), agent._id),
    findAgentKnowledge(getDb(), agent._id),
  ]);
  return { ...agent, skills, knowledge };
}

/** A 400 body when `modelId` names neither a power level nor a catalogue model, else null. */
export async function refuseUnknownModel(
  modelId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (typeof modelId !== 'string') return null;
  try {
    await resolveModel(modelId);
    return null;
  } catch (error: unknown) {
    if (error instanceof ModelNotFoundError) {
      return { error: error.userMessage, param: 'modelId', code: ModelNotFoundError.WIRE_CODE };
    }
    throw error;
  }
}

/** What an edit may carry: the columns, the look, and the two child lists by id. */
export type AgentEdit = Omit<UpdateAgentInput, 'skillIds' | 'libraryFileIds'> & {
  skills?: string[];
  knowledge?: string[];
};

/** What only the account owns, written to Oxy, never to the row: the display name. */
export interface AgentAccountEdit {
  displayName?: string;
}

export type AgentEditOutcome =
  | { readonly ok: true; readonly agent: AgentRecord }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 502; readonly error: string };

/**
 * Apply an edit as `userId`, with their bearer. The caller has already validated the fields.
 * A write, so the actor's standing is asked afresh (`cache: false`), never read from a verdict.
 */
export async function applyAgentEdit(params: {
  agentId: string;
  userId: string;
  accessToken: string;
  edit: AgentEdit;
  /** The account's own fields (the name), set at Oxy before the row is written. */
  account?: AgentAccountEdit;
}): Promise<AgentEditOutcome> {
  const { agentId, userId, accessToken, edit, account } = params;
  const loaded = await loadAgentForActor(getDb(), {
    agentId,
    oxyUserId: userId,
    accessToken,
    cache: false,
  });
  if (!loaded.ok) return refused(loaded.refusal);

  // The look lives on the Oxy account too, and every other app draws it from there: change it
  // there first, so a refusal leaves the agent as it was.
  if (edit.character !== undefined) {
    try {
      await setAgentAccountCharacter({
        accessToken,
        oxyAccountId: loaded.agent.oxyAccountId,
        character: edit.character,
      });
    } catch (error: unknown) {
      log.agents.warn({ err: error, agentId }, 'Oxy refused the look');
      return { ok: false, status: 502, error: 'Could not set the agent’s look on its account' };
    }
  }

  if (account?.displayName !== undefined) {
    try {
      await setAgentAccountName({
        accessToken,
        oxyAccountId: loaded.agent.oxyAccountId,
        displayName: account.displayName,
      });
    } catch (error: unknown) {
      log.agents.warn({ err: error, agentId }, 'Oxy refused the name');
      return { ok: false, status: 502, error: 'Could not rename the agent’s account' };
    }
  }

  const { skills, knowledge, ...columns } = edit;
  const agent = await updateAgent(getDb(), agentId, {
    ...columns,
    ...(skills !== undefined && { skillIds: skills }),
    ...(knowledge !== undefined && { libraryFileIds: knowledge }),
  });
  if (!agent) return { ok: false, status: 404, error: 'Agent not found' };
  return { ok: true, agent };
}

function refused(refusal: AgentAccountRefusal | 'agent_not_found'): AgentEditOutcome {
  if (refusal === 'agent_not_found') return { ok: false, status: 404, error: 'Agent not found' };
  return { ok: false, status: refusalStatus(refusal), error: refusalMessage(refusal) };
}

/** An agent as `GET /agents/:id` answers with it: child lists attached, identity resolved. */
export async function agentAnswer(agent: AgentRecord) {
  return withoutInternalAgentBindings(await attachAgentIdentity(await withChildLists(agent)));
}
