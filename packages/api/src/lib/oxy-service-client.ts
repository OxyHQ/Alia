/** Alia's own service identity is an attested workload, never a customer key. */
import {
  OxyServer,
  type ServiceTokenAudience,
  canAttestWorkloadIdentity,
} from '@oxy.so/core/server';
import { log } from './logger.js';

let client: OxyServer | null | undefined;

export function canAuthenticateAsOxyService(env: NodeJS.ProcessEnv = process.env): boolean {
  return canAttestWorkloadIdentity(env);
}

export function oxyServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const baseURL = (process.env.OXY_API_URL ?? '').trim();
  if (!baseURL || !canAuthenticateAsOxyService()) {
    log.general.warn(
      'Oxy service identity unavailable: configure the API origin and workload identity',
    );
    client = null;
  } else {
    client = new OxyServer({ baseURL });
  }
  return client;
}

function requireOxyServiceClient(): OxyServer {
  const oxy = oxyServiceClient();
  if (!oxy) throw new Error('Alia has no attested Oxy workload identity');
  return oxy;
}

export async function oxyServiceToken(): Promise<string> {
  return requireOxyServiceClient().serviceToken();
}

/** The SDK owns audience isolation, caching, refresh and retry. */
export async function oxyServiceTokenFor(audience: ServiceTokenAudience): Promise<string> {
  return requireOxyServiceClient().serviceTokenFor(audience);
}
