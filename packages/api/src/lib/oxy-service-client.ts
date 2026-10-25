import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
/** Alia's own service identity is an attested workload, never a customer key. */
import { OxyServer } from '@oxy.so/core/server';
import { log } from './logger.js';

let client: OxyServer | null | undefined;

export function canAuthenticateAsOxyService(env: NodeJS.ProcessEnv = process.env): boolean {
  // Provider resolution is asynchronous (ECS/EKS/SSO/assumed role), at mint time.
  return Boolean((env.OXY_API_URL ?? '').trim());
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
    client = new OxyServer({ baseURL, workloadCredentials: createAwsWorkloadCredentialProvider() });
  }
  return client;
}
