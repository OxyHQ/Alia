import type { Workflow, WorkflowExecution } from './workflow-types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiOptions extends RequestInit {
  token?: string;
}

interface WorkflowData {
  name: string;
  nodes: unknown[];
  edges: unknown[];
}

interface ExecuteData {
  nodes: unknown[];
  edges: unknown[];
}

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { token, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...fetchOptions,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const apiClient = {
  // Workflow endpoints
  workflows: {
    list: (token: string) =>
      apiRequest<{ workflows: Workflow[] }>('/api/workflows', { token }),

    get: (id: string, token: string) =>
      apiRequest<{ workflow: Workflow }>(`/api/workflows/${id}`, { token }),

    create: (data: WorkflowData, token: string) =>
      apiRequest<{ workflow: Workflow }>('/api/workflows', {
        method: 'POST',
        body: JSON.stringify(data),
        token,
      }),

    update: (id: string, data: Partial<WorkflowData>, token: string) =>
      apiRequest<{ workflow: Workflow }>(`/api/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
        token,
      }),

    delete: (id: string, token: string) =>
      apiRequest<{ message: string }>(`/api/workflows/${id}`, {
        method: 'DELETE',
        token,
      }),

    executions: (id: string, token: string) =>
      apiRequest<{ executions: WorkflowExecution[] }>(`/api/workflows/${id}/executions`, { token }),
  },

  // Execution endpoint
  execute: (data: ExecuteData, token: string) =>
    apiRequest<{ executionId: string; status: string; results: unknown[]; finalOutput: string }>(
      '/api/execute',
      {
        method: 'POST',
        body: JSON.stringify(data),
        token,
      }
    ),
};
