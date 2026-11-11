/**
 * Group conversations: how many agents one can hold.
 *
 * A group of one is an ordinary agent thread, so a group starts at two. Six is where the
 * conversation stops being followable (every message is answered by every member, in order) and
 * where each person's message starts costing six turns.
 *
 * A leaf module: it imports nothing (`db/__tests__/schemaModelIndependence.test.ts`).
 */
const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;

export type GroupMembers =
  | { readonly ok: true; readonly agentIds: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * The members a request names: two to six distinct, non-empty agent ids, in the order they should
 * answer. Pure shape: whether each id is an agent the person can reach is the route's to check.
 */
export function parseGroupMembers(value: unknown): GroupMembers {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
    return { ok: false, error: 'agentIds must be an array of agent ids' };
  }
  const agentIds = value as string[];
  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, error: 'agentIds must not repeat an agent' };
  }
  if (agentIds.length < GROUP_MIN_MEMBERS || agentIds.length > GROUP_MAX_MEMBERS) {
    return {
      ok: false,
      error: `A group holds ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS} agents`,
    };
  }
  return { ok: true, agentIds };
}
