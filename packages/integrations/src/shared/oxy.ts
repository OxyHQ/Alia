import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OxyServer } from '@oxy.so/core/server';
import { createAliaTransportForOxyService } from '@alia.onl/server';

export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
let apiTransport: ReturnType<typeof createAliaTransportForOxyService> | undefined;
export function aliaApiFetch(input: string, init?: RequestInit): Promise<Response> {
  apiTransport ??= createAliaTransportForOxyService(oxy, {
    baseURL: process.env.API_BASE_URL || 'http://localhost:4150',
  });
  return apiTransport.fetch(input, init);
}
