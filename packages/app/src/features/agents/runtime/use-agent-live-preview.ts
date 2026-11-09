import { type AliaAgentProfile, aliaQueryKeys } from '@alia.onl/sdk/runtime';
import { useQueryClient } from '@tanstack/react-query';
import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { useMemo } from 'react';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';

/** What of an agent the person sees all over the app and changes in the editor. */
export interface AgentLook {
  name?: string;
  tagline?: string;
  character?: AvatarCharacter;
}

/**
 * An edit of how an agent looks, shown EVERYWHERE the moment it is made.
 *
 * Every screen that draws an agent reads it from a query: the sidebar's rows from the person's
 * list, an open chat's header from the agent's profile, the detail screen from the agent itself.
 * The editor saves on a pause, and those queries only changed once the save had landed and they
 * had been read again, so a new avatar reached the editor at once and the rest of the app a second
 * or two later. Here the edit is written into the three queries as it is made, and the save
 * (and the read after it) only confirms it.
 *
 * Only entries already in the cache are touched: an agent nobody has loaded has nothing to show
 * the edit on. A save that fails puts what the server holds back (`revert`).
 */
export function useAgentLivePreview(agentId: string) {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const merge = <T extends { name?: unknown; character?: unknown }>(
      current: T,
      look: AgentLook,
      fields: ReadonlyArray<keyof AgentLook>,
    ): T => {
      const patch: Record<string, unknown> = {};
      for (const field of fields) if (look[field] !== undefined) patch[field] = look[field];
      return { ...current, ...patch };
    };
    return {
      show(look: AgentLook) {
        queryClient.setQueryData<Agent[]>(queryKeys.agents.mine, (list) =>
          list?.map((agent) =>
            agent._id === agentId ? merge(agent, look, ['name', 'tagline', 'character']) : agent,
          ),
        );
        queryClient.setQueryData<Agent>(queryKeys.agents.detail(agentId), (agent) =>
          agent ? merge(agent, look, ['name', 'tagline', 'character']) : agent,
        );
        // The profile has no tagline: its name and look are what the chat's header draws.
        queryClient.setQueryData<AliaAgentProfile>(
          aliaQueryKeys.agents.profile(agentId),
          (profile) => (profile ? merge(profile, look, ['name', 'character']) : profile),
        );
      },
      /** The save did not land: read what the server holds again. */
      revert() {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
        void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.agents.profile(agentId) });
      },
    };
  }, [queryClient, agentId]);
}
