import { useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';
import { errorStatus } from '../errors/error-utils';

/**
 * The permanent thread between the signed-in person and one agent.
 *
 * `/a/pepe` is not a link to a conversation, it is the conversation — one per
 * (person, agent) pair, the way a DM is one per pair. `GET /agents/thread/:username`
 * resolves the username through Oxy's global namespace and answers with that
 * pair's conversation, creating it the first time. Opening the same URL twice
 * is the same thread; two people opening the same agent are two threads.
 *
 * ## Three of the agent's fields are nullable, and that is the ordinary path
 *
 * `name`, `handle` and `color` live on the agent's Oxy bot account and are
 * resolved through a batched lookup that FAILS OPEN. An account Oxy cannot
 * resolve — deleted, federated, or simply unreachable — arrives with all three
 * null while the thread itself is perfectly usable, because the conversation and
 * the tagline are Alia's own. Every reader therefore renders a fallback rather
 * than asserting.
 *
 * ## 404 is the only refusal, and it must stay that way
 *
 * An agent that does not exist and an agent this person cannot reach answer
 * IDENTICALLY. A 403 would confirm the agent exists, which is exactly what an
 * unpublished agent's owner did not agree to — so the screen shows one message
 * for both and this hook does not retry either.
 */
export interface AgentThreadIdentity {
  _id: string;
  name: string | null;
  handle: string | null;
  color: string | null;
  tagline: string;
  description: string;
}

export interface AgentThread {
  agent: AgentThreadIdentity;
  conversationId: string;
}

export function useAgentThread(username: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.thread(username ?? ''),
    queryFn: async (): Promise<AgentThread> => {
      const response = await apiClient.get<AgentThread>(API_ROUTES.agents.thread(username ?? ''));
      return response.data;
    },
    enabled: typeof username === 'string' && username.length > 0,
    /**
     * A 404 is an ANSWER here, not a failure to get one: the agent does not
     * exist, or this person cannot reach it. Retrying re-asks a question that
     * has already been answered, and does it three times before the screen is
     * allowed to say so.
     */
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 2,
  });
}
