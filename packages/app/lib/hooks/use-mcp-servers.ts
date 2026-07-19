import { useState, useEffect, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  url?: string;
  requiredEnv: string[];
  requiresOAuth?: boolean;
  featured?: boolean;
  category: string;
}

export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface InstalledMcpServer {
  _id: string;
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  source: 'registry' | 'custom';
  registryId?: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  runtime: 'server' | 'local';
  config: {
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    requiresOAuth?: boolean;
  };
  status: 'installed' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  tools: McpServerTool[];
  enabled: boolean;
}

export function useMcpServers() {
  const { isAuthenticated } = useOxy();
  const [registry, setRegistry] = useState<McpRegistryEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const [registryRes, installedRes] = await Promise.all([
        apiClient.get('/mcp/registry'),
        apiClient.get('/mcp/installed'),
      ]);
      setRegistry(registryRes.data.servers || []);
      setInstalled(installedRes.data.servers || []);
      setError(null);
    } catch (err: unknown) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const install = async (
    registryId: string,
    env?: Record<string, string>,
  ): Promise<InstalledMcpServer> => {
    const res = await apiClient.post('/mcp/install', { registryId, env });
    await fetchAll();
    return res.data.server as InstalledMcpServer;
  };

  const installCustom = async (params: {
    name: string;
    displayName: string;
    transport: string;
    config: { url?: string; headers?: Record<string, string>; env?: Record<string, string> };
  }) => {
    await apiClient.post('/mcp/install', params);
    await fetchAll();
  };

  const uninstall = async (serverId: string) => {
    await apiClient.delete(`/mcp/${serverId}`);
    await fetchAll();
  };

  const start = async (serverId: string) => {
    await apiClient.post(`/mcp/${serverId}/start`);
    await fetchAll();
  };

  const stop = async (serverId: string) => {
    await apiClient.post(`/mcp/${serverId}/stop`);
    await fetchAll();
  };

  const updateConfig = async (serverId: string, updates: Partial<InstalledMcpServer>) => {
    await apiClient.patch(`/mcp/${serverId}`, updates);
    await fetchAll();
  };

  // Begin the interactive OAuth flow for a remote connector. Returns the
  // authorization URL the client opens; the provider redirects back to the
  // Connectors screen with ?mcp_oauth_state=&mcp_oauth_code= for completeOAuth.
  const startOAuth = async (serverId: string): Promise<string> => {
    const res = await apiClient.post(`/mcp/${serverId}/oauth/start`);
    return res.data.authorizationUrl;
  };

  // Finalize the OAuth link once the browser returns with state + code.
  const completeOAuth = async (state: string, code: string): Promise<void> => {
    await apiClient.post('/mcp/oauth/complete', { state, code });
    await fetchAll();
  };

  return {
    registry,
    installed,
    loading,
    error,
    install,
    installCustom,
    uninstall,
    start,
    stop,
    updateConfig,
    startOAuth,
    completeOAuth,
    refresh: fetchAll,
  };
}
