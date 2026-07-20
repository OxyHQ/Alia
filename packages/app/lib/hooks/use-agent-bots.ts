import { useState, useEffect, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export interface AgentBot {
  _id: string;
  platform: string;
  botId: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  status: 'active' | 'inactive' | 'error';
  userId?: string;
  agentId?: string;
}

/**
 * Bots bound to a specific agent and owned by the current user.
 *
 * `GET /bots` returns the system bot (no `userId`) plus the caller's own bots;
 * we filter to the user-owned bots bound to this agent.
 */
export function useAgentBots(agentId: string | undefined) {
  const { isAuthenticated } = useOxy();
  const [bots, setBots] = useState<AgentBot[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!isAuthenticated || !agentId) {
      setBots([]);
      setLoading(false);
      return;
    }

    try {
      const response = await apiClient.get('/bots');
      const all: AgentBot[] = response.data.bots || [];
      setBots(all.filter((b) => b.userId && b.agentId === agentId));
    } catch {
      setBots([]);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, agentId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const registerBot = useCallback(
    async (botToken: string) => {
      await apiClient.post('/bots/telegram', { botToken, agentId });
      await fetchAll();
    },
    [agentId, fetchAll],
  );

  const removeBot = useCallback(
    async (botId: string) => {
      await apiClient.delete(`/bots/${botId}`);
      await fetchAll();
    },
    [fetchAll],
  );

  return {
    bots,
    loading,
    registerBot,
    removeBot,
    refresh: fetchAll,
  };
}
