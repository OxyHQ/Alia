import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import type {
  AgentComputer,
  BrowserController,
  BrowserInput,
  BrowserScreenshot,
  BrowserStatus,
  ComputerReceipts,
  WorkspaceListing,
} from '@/features/agents/model/computer';

/**
 * The agent's computer, live: the person's OWN computer with this agent
 * (the API composes it from the signed-in account — `routes/agents/computer.ts`).
 *
 * ## Polling, and only while someone is looking
 *
 * The screenshot is polled every {@link SCREENSHOT_POLL_MS} — like OpenMuse's
 * browser console — but only while the screen is on show, the app is in the
 * foreground and the browser is actually open. A view left open in a
 * background tab must not be what keeps the agent's browser, or the whole
 * host, awake; the API never wakes a sleeping host to answer a status anyway.
 */

export const SCREENSHOT_POLL_MS = 1500;
const STATUS_POLL_MS = 5000;
/** Browser actions can wait for a navigation (25 s) on a host that was asleep. */
const ACTION_TIMEOUT_MS = 90_000;

export const agentComputerKey = (agentId: string) => ['agent-computer', agentId] as const;

/** Whether the app is in the foreground (always true on web, where the tab decides). */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}

export function useAgentComputer(agentId: string, live: boolean) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: agentComputerKey(agentId),
    queryFn: async () => (await apiClient.get<AgentComputer>(API_ROUTES.agents.computer(agentId))).data,
    enabled: isAuthenticated && Boolean(agentId),
    refetchInterval: live ? STATUS_POLL_MS : false,
    retry: false,
  });
}

export function useBrowserScreenshot(agentId: string, live: boolean) {
  return useQuery({
    queryKey: [...agentComputerKey(agentId), 'screenshot'],
    queryFn: async () => (await apiClient.get<BrowserScreenshot>(API_ROUTES.agents.computerScreenshot(agentId))).data,
    enabled: live,
    refetchInterval: live ? SCREENSHOT_POLL_MS : false,
    // The last frame stays on screen while the next one loads.
    placeholderData: (previous) => previous,
    retry: false,
    gcTime: 0,
  });
}

export function useComputerReceipts(agentId: string, live: boolean) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: [...agentComputerKey(agentId), 'receipts'],
    queryFn: async () => (await apiClient.get<ComputerReceipts>(API_ROUTES.agents.computerReceipts(agentId))).data,
    enabled: isAuthenticated && Boolean(agentId),
    refetchInterval: live ? 10_000 : false,
    retry: false,
  });
}

/** A directory of the agent's /workspace; only asked while its computer runs. */
export function useWorkspaceFiles(agentId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: [...agentComputerKey(agentId), 'files', path],
    queryFn: async () => (await apiClient.get<WorkspaceListing>(API_ROUTES.agents.computerFiles(agentId, path))).data,
    enabled,
    retry: false,
  });
}

/** Everything the person can DO from the live view. Each one acts as the owner. */
export function useComputerActions(agentId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: agentComputerKey(agentId) });
  const writeBrowser = (browser: BrowserStatus) =>
    queryClient.setQueryData<AgentComputer>(agentComputerKey(agentId), (current) =>
      current ? { ...current, browser: { ...current.browser, ...browser } } : current,
    );

  const input = useMutation({
    mutationFn: async (value: BrowserInput) =>
      (await apiClient.post<BrowserStatus>(API_ROUTES.agents.computerBrowserInput(agentId), { input: value }, { timeout: ACTION_TIMEOUT_MS })).data,
    onSuccess: writeBrowser,
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...agentComputerKey(agentId), 'screenshot'] }),
  });

  const control = useMutation({
    mutationFn: async (controller: BrowserController) =>
      (await apiClient.post<BrowserStatus>(API_ROUTES.agents.computerBrowserControl(agentId), { controller }, { timeout: ACTION_TIMEOUT_MS })).data,
    onSuccess: writeBrowser,
    onSettled: refresh,
  });

  const navigate = useMutation({
    mutationFn: async (url: string) =>
      (await apiClient.post<BrowserStatus>(API_ROUTES.agents.computerBrowserNavigate(agentId), { url }, { timeout: ACTION_TIMEOUT_MS })).data,
    onSuccess: writeBrowser,
    onSettled: refresh,
  });

  const open = useMutation({
    mutationFn: async (url?: string) =>
      (await apiClient.post<BrowserStatus>(API_ROUTES.agents.computerBrowserOpen(agentId), url ? { url } : {}, { timeout: ACTION_TIMEOUT_MS })).data,
    onSuccess: writeBrowser,
    onSettled: refresh,
  });

  const start = useMutation({
    mutationFn: async () => {
      await apiClient.post(API_ROUTES.agents.computerStart(agentId), {}, { timeout: ACTION_TIMEOUT_MS });
    },
    onSettled: refresh,
  });

  return { input, control, navigate, open, start };
}
