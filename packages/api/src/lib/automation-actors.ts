/**
 * Which agents an automation may run for its owner, decided without a person
 * present — shared by creating an automation and dispatching one, so the two
 * cannot disagree about what was allowed.
 *
 * `author` is listing metadata and never authority (`docs/agents.md`). An
 * unattended run has no bearer to ask Oxy about membership with, so the rule
 * is the part of `canReachAgent` that needs none: the owner's own agent (its
 * reconciled Oxy owner), or a public, active marketplace agent. A private agent
 * shared by membership fails closed, and a product-bound agent is never a
 * marketplace actor.
 */
export function mayRunForAutomationOwner(
  agent: {
    readonly ownerOxyAccountId: string | null;
    readonly access: string;
    readonly status: string;
    readonly applicationId: string | null;
  },
  ownerAccountId: string,
): boolean {
  if (agent.applicationId != null) return false;
  if (agent.ownerOxyAccountId === ownerAccountId) return true;
  return agent.access === 'public' && agent.status === 'active';
}
