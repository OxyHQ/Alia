import { useState, useEffect, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export interface SystemBot {
  _id: string;
  platform: string;
  botId: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  status: 'active' | 'inactive' | 'error';
  defaultModel?: string;
  totalUsers: number;
  totalMessages: number;
}

export interface BotLinkStatus {
  linked: boolean;
  linkedAt?: string;
  username?: string;
}

export function useBots() {
  const { isAuthenticated } = useOxy();
  const [bots, setBots] = useState<SystemBot[]>([]);
  const [linkStatuses, setLinkStatuses] = useState<Record<string, BotLinkStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchBots = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const response = await apiClient.get('/bots');
      const botList: SystemBot[] = response.data.bots || [];
      setBots(botList);

      // Fetch link status for each bot
      const statuses: Record<string, BotLinkStatus> = {};
      await Promise.all(
        botList.map(async (bot) => {
          try {
            const statusRes = await apiClient.get(`/bots/${bot._id}/link-status`);
            statuses[bot._id] = statusRes.data;
          } catch {
            statuses[bot._id] = { linked: false };
          }
        })
      );
      setLinkStatuses(statuses);
      setError(null);
    } catch (err: unknown) {
      setError(err as Error);
      setBots([]);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  const link = async (botId: string, authToken: string) => {
    await apiClient.post(`/bots/${botId}/link`, { authToken });
    await fetchBots();
  };

  const unlink = async (botId: string) => {
    await apiClient.post(`/bots/${botId}/unlink`);
    await fetchBots();
  };

  return {
    bots,
    linkStatuses,
    loading,
    error,
    link,
    unlink,
    refresh: fetchBots,
  };
}
