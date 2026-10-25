import { ALIA_API_URL, AliaServerClient, type AliaServerClientOptions } from './client.js';
import { ALIA_SERVICE_AUDIENCE } from './identity.js';

export type AliaOxyRequester =
  | { accountId: string; token: string; taskId?: never; requesterContext?: never }
  | { accountId: string; taskId: string; token?: never; requesterContext?: never }
  | { accountId: string; requesterContext: string; token?: never; taskId?: never };

/** Structural boundary: the SDK never loads Oxy's server implementation. */
export interface OxyServiceTransportFactory {
  createServiceClient(options: {
    baseURL: string;
    audience: typeof ALIA_SERVICE_AUDIENCE;
    requester?: AliaOxyRequester;
  }): { fetch: typeof globalThis.fetch; dispose(): void };
}

export function createAliaTransportForOxyService(
  oxy: OxyServiceTransportFactory,
  options: { baseURL?: string; requester?: AliaOxyRequester } = {},
): { fetch: typeof globalThis.fetch; dispose(): void } {
  return oxy.createServiceClient({
    baseURL: options.baseURL ?? ALIA_API_URL,
    audience: ALIA_SERVICE_AUDIENCE,
    ...(options.requester === undefined ? {} : { requester: options.requester }),
  });
}

/** Alia through Oxy's workload transport, including its audience and refresh ownership. */
export function createAliaForOxyService(
  oxy: OxyServiceTransportFactory,
  options: Omit<AliaServerClientOptions, 'fetch' | 'token'> & {
    requester?: AliaOxyRequester;
  } = {},
): AliaServerClient & { dispose(): void } {
  const { requester, ...clientOptions } = options;
  const transport = createAliaTransportForOxyService(oxy, {
    baseURL: options.baseUrl ?? ALIA_API_URL,
    ...(requester === undefined ? {} : { requester }),
  });
  return Object.assign(new AliaServerClient({ ...clientOptions, fetch: transport.fetch }), {
    dispose: () => transport.dispose(),
  });
}
