import { ClarityClient } from '@clarity.surf/sdk';

import { oxyServiceClient } from './oxy-service-client.js';

let client: ClarityClient | undefined;

export function clarityClient(): ClarityClient {
  if (client) return client;
  const oxy = oxyServiceClient();
  if (!oxy) throw new Error('Alia Oxy service credential is not configured');
  client = new ClarityClient({
    baseUrl: process.env.CLARITY_API_URL?.trim() || 'https://api.clarity.surf',
    getAccessToken: () => oxy.getServiceToken(),
  });
  return client;
}
