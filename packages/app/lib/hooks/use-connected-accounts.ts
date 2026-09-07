import { useState, useEffect, useRef, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';
import { errorStatus } from '../errors/error-utils';

export interface ConnectedAccount {
  _id: string;
  platform: string;
  accountId: string;
  displayName?: string;
  phoneNumber?: string;
  email?: string;
  avatarUrl?: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'expired';
  statusMessage?: string;
  sessionId?: string;
  autoReply: boolean;
  autoReplyAgentId?: string;
  customContext?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedSkillIds?: string[];
  lastActiveAt?: string;
  connectedAt?: string;
}

export function useConnectedAccounts(platform?: string) {
  const { isAuthenticated } = useOxy();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [activeQRAccountId, setActiveQRAccountId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * The most recently STARTED fetch. Only that one may write.
   *
   * There are five callers — the `platform` effect, the three-second poll, and
   * `connect` / `disconnect` / `remove` / `updateSettings`, each of which
   * refetches — so two requests are routinely in flight, and they resolved in
   * arrival order with no guard at all. A poll issued before `disconnect()`
   * could land after it and put the disconnected account back on screen, where
   * it stayed until the next tick happened to land in the other order.
   *
   * A counter rather than an `AbortController`: aborting would also cancel a
   * request whose RESULT is still wanted by nobody, but the cheap and correct
   * property here is simply "the last request to start is the one that wins".
   */
  const requestSeq = useRef(0);

  const fetchAccounts = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    /** A newer fetch has started; this one's answer is stale. */
    const superseded = () => requestSeq.current !== seq;

    try {
      const url = platform ? `/accounts/${platform}` : '/accounts';
      const response = await apiClient.get(url);
      if (superseded()) return;
      setAccounts(response.data.accounts || []);
      setError(null);
    } catch (err: unknown) {
      if (superseded()) return;
      if (errorStatus(err) === 404 || errorStatus(err) === 503) {
        setAccounts([]);
      } else {
        setError(err as Error);
        setAccounts([]);
      }
    } finally {
      // `loading` describes the screen, not this request, so only the newest
      // fetch may clear it — an older one finishing first would otherwise
      // report "loaded" while the current request is still out.
      if (!superseded()) setLoading(false);
    }
  }, [isAuthenticated, platform]);

  const fetchAccountsRef = useRef(fetchAccounts);
  useEffect(() => {
    fetchAccountsRef.current = fetchAccounts;
  }, [fetchAccounts]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Poll for status changes when actively connecting
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (activeQRAccountId && isAuthenticated) {
      intervalRef.current = setInterval(() => fetchAccountsRef.current(), 3000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [activeQRAccountId, isAuthenticated]);

  // Clear polling when account connects
  useEffect(() => {
    if (activeQRAccountId) {
      const account = accounts.find(a => a._id === activeQRAccountId);
      if (account?.status === 'connected') {
        setActiveQRAccountId(null);
      }
    }
  }, [accounts, activeQRAccountId]);

  const connect = async (platformId: string): Promise<{ accountId: string; qr?: string; oauthUrl?: string }> => {
    const response = await apiClient.post(`/accounts/${platformId}/connect`);
    const data = response.data;
    if (data.accountId) {
      setActiveQRAccountId(data.accountId);
    }
    await fetchAccounts();
    return data;
  };

  const disconnect = async (accountId: string) => {
    await apiClient.post(`/accounts/${accountId}/disconnect`);
    setActiveQRAccountId(null);
    await fetchAccounts();
  };

  const remove = async (accountId: string) => {
    await apiClient.delete(`/accounts/${accountId}`);
    await fetchAccounts();
  };

  const getQR = async (accountId: string): Promise<string | null> => {
    try {
      const response = await apiClient.get(`/accounts/${accountId}/qr`);
      return response.data.qr || null;
    } catch {
      return null;
    }
  };

  const updateSettings = async (accountId: string, settings: Partial<Pick<ConnectedAccount, 'autoReply' | 'autoReplyAgentId' | 'customContext' | 'allowedTools' | 'blockedTools' | 'allowedSkillIds'>>) => {
    await apiClient.patch(`/accounts/${accountId}/settings`, settings);
    await fetchAccounts();
  };

  const stopPolling = () => {
    setActiveQRAccountId(null);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const connectedCount = accounts.filter(a => a.status === 'connected').length;

  return {
    accounts,
    connectedCount,
    loading,
    error,
    activeQRAccountId,
    connect,
    disconnect,
    remove,
    getQR,
    updateSettings,
    refresh: fetchAccounts,
    stopPolling,
  };
}
