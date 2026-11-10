/**
 * Whether external agents are connected right now, for the lists that show them (ADR 0030).
 * The relay is loaded on first use: it pulls the Oxy socket verifier in at import time, which the
 * agent list must not pay for when the person has no external agent.
 */
export async function externalAgentPresence(
  agentIds: readonly string[],
): Promise<Map<string, boolean>> {
  const present = new Map<string, boolean>();
  if (agentIds.length === 0) return present;
  const { isExternalAgentReachable } = await import('./relay.js');
  await Promise.all(
    agentIds.map(async (id) => {
      present.set(id, await isExternalAgentReachable(id));
    }),
  );
  return present;
}
