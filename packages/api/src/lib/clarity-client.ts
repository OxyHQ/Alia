import type { ClarityClient } from '@clarity.surf/sdk';
import { clarityForOxyService } from '@clarity.surf/sdk/server';

import { oxy } from './oxy.js';

let client: ClarityClient | undefined;

export function clarityClient(): ClarityClient {
  if (client) return client;
  client = clarityForOxyService(oxy, {
    baseUrl: process.env.CLARITY_API_URL?.trim() || 'https://api.clarity.surf',
  });
  return client;
}

export function disposeClarityClient(): void {
  client?.dispose();
  client = undefined;
}
