import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { automationControlRequests } from '../automations/control';
import type {
  AutomationDefinition,
  AutomationOverview,
  AutomationRun,
  AutomationStep,
  LegacyAutomationCreateInput,
} from '../automations/types';
import { createRandomUuid } from '../utils/random-uuid';
import { queryKeys } from './query-keys';

async function invalidateOverview(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.automations.overview });
}

export interface AutomationControlResult {
  revocation?: { revoked: number; failed: number };
}

export function useAutomationOverview() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.automations.overview,
    queryFn: async (): Promise<AutomationOverview> => {
      const [definitions, runs] = await Promise.all([
        apiClient.get<{ automations: AutomationDefinition[] }>(API_ROUTES.automations.list),
        apiClient.get<{ runs: AutomationRun[] }>(API_ROUTES.automations.runs),
      ]);
      return { automations: definitions.data.automations, runs: runs.data.runs };
    },
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

export function useAutomationRuns(automationId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.automations.history(automationId),
    queryFn: async (): Promise<AutomationRun[]> => {
      const response = await apiClient.get<{ runs: AutomationRun[] }>(API_ROUTES.automations.runs, {
        params: { automationId },
      });
      return response.data.runs;
    },
    enabled: isAuthenticated && Boolean(automationId),
    staleTime: 30_000,
  });
}

export function useAutomationRunSteps(runId: string, enabled: boolean) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.automations.steps(runId),
    queryFn: async (): Promise<AutomationStep[]> => {
      const response = await apiClient.get<{ steps: AutomationStep[] }>(
        API_ROUTES.automations.steps(runId),
      );
      return response.data.steps;
    },
    enabled: isAuthenticated && enabled && Boolean(runId),
    staleTime: 30_000,
  });
}

export function useCreateLegacyAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LegacyAutomationCreateInput): Promise<void> => {
      await apiClient.post(API_ROUTES.triggers.create, input);
    },
    onSuccess: () => invalidateOverview(queryClient),
  });
}

export function useSetAutomationEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ automation, enabled }: {
      automation: AutomationDefinition;
      enabled: boolean;
    }): Promise<AutomationControlResult> => {
      const request = automationControlRequests(automation).update;
      const response = await apiClient.patch<AutomationControlResult>(request.path, { enabled });
      return response.data;
    },
    onSuccess: () => invalidateOverview(queryClient),
  });
}

export function useStopAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (automation: AutomationDefinition): Promise<AutomationControlResult> => {
      const request = automationControlRequests(automation).stop;
      if (request.method === 'PATCH') {
        const response = await apiClient.patch<AutomationControlResult>(request.path, { enabled: false });
        return response.data;
      }
      const response = await apiClient.delete<AutomationControlResult>(request.path);
      return response.data;
    },
    onSuccess: () => invalidateOverview(queryClient),
  });
}

export function useRunAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (automation: AutomationDefinition): Promise<void> => {
      const request = automationControlRequests(automation).run;
      if (!request) {
        throw new Error('Only manual structured automations can be run on request');
      }
      await apiClient.post(
        request.path,
        undefined,
        automation.legacyTriggerId
          ? undefined
          : { headers: { 'Idempotency-Key': createRandomUuid() } },
      );
    },
    onSuccess: () => invalidateOverview(queryClient),
  });
}
