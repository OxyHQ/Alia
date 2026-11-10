import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

type ExternalCli = 'claude' | 'codex' | 'opencode';

/** One coding-agent CLI the person connected, and whether its computer is reachable right now. */
export interface ExternalAgent {
  agentId: string;
  cli: ExternalCli;
  hostName: string;
  online: boolean;
  createdAt: string;
  lastConnectedAt: string | null;
}

/** A single-use code and the text to paste into the agent. */
export interface PairingInvite {
  code: string;
  expiresAt: string;
  prompt: string;
}

/** The list is re-read while the section is open, so "Connected" shows without a refresh. */
const REFRESH_MS = 6000;

export function useExternalAgents(locale: string) {
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<PairingInvite | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    try {
      const response = await apiClient.get<{ agents: ExternalAgent[] }>(
        API_ROUTES.agents.external.list,
      );
      setAgents(response.data.agents ?? []);
    } catch {
      // Keep what is on screen; the next tick tries again.
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Mints a code. Throws when the server refuses (the caller shows the toast). */
  const createInvite = useCallback(async () => {
    const response = await apiClient.post<PairingInvite>(API_ROUTES.agents.external.pair, {
      locale,
    });
    setInvite(response.data);
    return response.data;
  }, [locale]);

  const remove = useCallback(
    async (agentId: string) => {
      await apiClient.delete(API_ROUTES.agents.external.remove(agentId));
      setAgents((current) => current.filter((agent) => agent.agentId !== agentId));
      // The agent leaves the sidebar's list too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine });
    },
    [queryClient],
  );

  return { agents, loading, invite, createInvite, remove };
}
