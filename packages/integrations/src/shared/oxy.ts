import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OxyServer } from '@oxy.so/core/server';
import {
  ALIA_APPLICATION_ID,
  ALIA_SERVICE_AUDIENCE,
  createAliaTransportForOxyService,
} from '@alia.onl/server';

/** This process's one Oxy client: Alia's integrations workload (oxy ADR 0026/0049). */
export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  applicationId: ALIA_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  expectedAudience: ALIA_SERVICE_AUDIENCE,
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
let apiTransport: ReturnType<typeof createAliaTransportForOxyService> | undefined;
export function aliaApiFetch(input: string, init?: RequestInit): Promise<Response> {
  apiTransport ??= createAliaTransportForOxyService(oxy, {
    baseURL: process.env.API_BASE_URL || 'http://localhost:4150',
  });
  return apiTransport.fetch(input, init);
}
