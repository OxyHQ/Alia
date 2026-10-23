import { createAliaTransportForOxyService } from '@alia.onl/server';
import { ALIA_ACCOUNT_CONTEXT_HEADER } from '@alia.onl/server/internal';
import { isLiveEntityId } from '@oxy.so/db';
import { oxyServiceClient } from './oxy-service-client.js';

const transports = new Map<string, ReturnType<typeof createAliaTransportForOxyService>>();

/** Internal product context, derived by the API from a session/task or an owned connector row.
 * It is never an Oxy user authentication header and is not forwarded to another product. */
export async function integrationsFetch(
  accountId: string,
  path: string,
  init: RequestInit = {},
  baseURL = process.env.INTEGRATIONS_URL,
): Promise<Response> {
  if (!baseURL || !isLiveEntityId(accountId))
    throw new Error('Integrations account context unavailable');
  let transport = transports.get(baseURL);
  if (!transport) {
    const oxy = oxyServiceClient();
    if (!oxy) throw new Error('Alia workload identity unavailable');
    transport = createAliaTransportForOxyService(oxy, { baseURL });
    transports.set(baseURL, transport);
  }
  const headers = new Headers(init.headers);
  headers.delete('x-oxy-user-id');
  headers.delete('x-oxy-requester-token');
  headers.delete('x-gateway-secret');
  headers.set(ALIA_ACCOUNT_CONTEXT_HEADER, accountId);
  return transport.fetch(path, { ...init, headers });
}
