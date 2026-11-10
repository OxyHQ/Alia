/**
 * Which computer an agent works on for a person (`AGENT_COMPUTER_SOURCES`).
 *
 * The ONE place that decides, used by the agent's tools and by the live view alike, so what the person
 * watches is what the agent is using.
 *
 *  - `own`: `agent:<agentId>:user:<userId>`, a machine of the agent's, per person.
 *  - `alia` (the default): `alia:user:<userId>`, the person's shared workspace.
 *
 * An agent in a SPACE (ADR 0028) that is on the default (`alia`) works on the space's shared workspace,
 * `space:<spaceId>:user:<userId>`, the same machine for every member, so what one makes is there for the
 * next. An agent whose owner chose `own` keeps its own machine even inside a space.
 *
 * `alia` and the space's workspace are honoured ONLY when the person is the agent's owner. Someone using another person's public
 * agent would otherwise hand that agent their personal workspace, and the owner's choice must not be
 * able to do that to them; they get the agent's own per-person machine instead, as before.
 */

import type { AgentComputerSource } from '../../domain/agent.js';
import { agentActorId, aliaActorId, spaceActorId } from './computer-client.js';

export function resolveComputerActor(input: {
  readonly agent: {
    readonly _id: string;
    readonly ownerOxyAccountId: string | null;
    readonly computerSource: AgentComputerSource;
    /** The space the agent is in, or null. */
    readonly spaceId: string | null;
  };
  readonly oxyUserId: string;
}): string {
  const { agent, oxyUserId } = input;
  if (
    agent.computerSource === 'alia' &&
    agent.ownerOxyAccountId !== null &&
    agent.ownerOxyAccountId === oxyUserId
  ) {
    return agent.spaceId === null ? aliaActorId(oxyUserId) : spaceActorId(agent.spaceId, oxyUserId);
  }
  return agentActorId(agent._id, oxyUserId);
}
