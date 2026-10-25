import type { ClarityClient } from '@clarity.surf/sdk';
import { clarityForOxyService } from '@clarity.surf/sdk/server';

import { oxyServiceClient } from './oxy-service-client.js';

let client: ClarityClient | undefined;

export function clarityClient(): ClarityClient {
  if (client) return client;
  const oxy = oxyServiceClient();
  if (!oxy) throw new Error('Alia Oxy workload identity is not configured');
  client = clarityForOxyService(oxy, {
    baseUrl: process.env.CLARITY_API_URL?.trim() || 'https://api.clarity.surf',
  });
  return client;
}

export function disposeClarityClient(): void {
  client?.dispose();
  client = undefined;
}
