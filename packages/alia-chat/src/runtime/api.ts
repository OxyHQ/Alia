import { useOxy } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import { useAliaRuntime } from './config';

/**
 * A refusal or failure from Alia's API, shaped so the helpers in
 * `error-utils.ts` read it: `status`, and the parsed body under
 * `response.data`.
 */
export class AliaApiError extends Error {
  readonly status: number;
  readonly response: { status: number; data: unknown };

  constructor(status: number, data: unknown, message?: string) {
    super(message ?? `Alia request failed with status ${status}.`);
    this.name = 'AliaApiError';
    this.status = status;
    this.response = { status, data };
  }
}

export interface AliaApiResult<T> {
  status: number;
  data: T;
}

export interface AliaApiRequest {
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Alia's REST API for the signed-in person. Authentication, the preflight
 * refresh and the single 401 replay belong to the linked Oxy client; this
 * layer never reads or writes a bearer itself.
 */
export interface AliaApi {
  get<T>(path: string, request?: AliaApiRequest): Promise<AliaApiResult<T>>;
  post<T>(path: string, body?: unknown, request?: AliaApiRequest): Promise<AliaApiResult<T>>;
  patch<T>(path: string, body?: unknown, request?: AliaApiRequest): Promise<AliaApiResult<T>>;
  delete<T>(path: string, request?: AliaApiRequest): Promise<AliaApiResult<T>>;
}

function withParams(path: string, params: AliaApiRequest['params']): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  const query = search.toString();
  return query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The structural slice of `OxyServices` the API layer needs. */
export interface LinkableOxy {
  createLinkedClient(config: { baseURL: string }): {
    client: {
      requestAuthenticatedResponse(config: {
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        body?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
        fetch?: typeof fetch;
      }): Promise<Response>;
    };
    dispose(): void;
  };
}

/** Build the API over an Oxy client for `apiUrl`. Exposed for tests and for non-React callers. */
export function createAliaApi(oxyServices: LinkableOxy, apiUrl: string): AliaApi {
  async function send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    request: AliaApiRequest = {},
  ): Promise<AliaApiResult<T>> {
    const linked = oxyServices.createLinkedClient({ baseURL: apiUrl });
    try {
      const response = await linked.client.requestAuthenticatedResponse({
        method,
        url: withParams(path, request.params),
        ...(request.body === undefined
          ? {}
          : {
              body: JSON.stringify(request.body),
              headers: { 'Content-Type': 'application/json' },
            }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const data = await readBody(response);
      if (!response.ok) throw new AliaApiError(response.status, data);
      return { status: response.status, data: data as T };
    } finally {
      linked.dispose();
    }
  }

  return {
    get: (path, request) => send('GET', path, request),
    post: (path, body, request) => send('POST', path, { ...request, body: body ?? {} }),
    patch: (path, body, request) => send('PATCH', path, { ...request, body: body ?? {} }),
    delete: (path, request) => send('DELETE', path, request),
  };
}

/** Alia's REST API for the nearest runtime's `apiUrl`, as the signed-in person. */
export function useAliaApi(): AliaApi {
  const { oxyServices } = useOxy();
  const { apiUrl } = useAliaRuntime();
  return useMemo(() => createAliaApi(oxyServices as LinkableOxy, apiUrl), [oxyServices, apiUrl]);
}
