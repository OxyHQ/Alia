import { agentOpensOn } from './agent-availability.js';

/**
 * Which agents an automation may run for its owner, decided without a person
 * present — shared by creating an automation and dispatching one, so the two
 * cannot disagree about what was allowed.
 *
 * `author` is listing metadata and never authority (`docs/agents.md`). An
 * unattended run has no bearer to ask Oxy about membership with, so the rule
 * is the part of `canReachAgent` that needs none: the owner's own agent (its
 * reconciled Oxy owner), or a public, active marketplace agent. A private agent
 * shared by membership fails closed.
 *
 * An unattended run is in no app, so an agent Oxy confines to an app never
 * runs one (ADR 0021) — asked of Oxy like every other reach, and refused when
 * Oxy could not answer.
 */
export async function mayRunForAutomationOwner(
  agent: {
    readonly oxyAccountId: string;
    readonly ownerOxyAccountId: string | null;
    readonly access: string;
    readonly status: string;
  },
  ownerAccountId: string,
): Promise<boolean> {
  const who =
    agent.ownerOxyAccountId === ownerAccountId ||
    (agent.access === 'public' && agent.status === 'active');
  if (!who) return false;
  return (await agentOpensOn(agent.oxyAccountId, null)) === 'reachable';
}
