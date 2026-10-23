import { createEcosystemTraffic } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

type EcosystemTraffic = ReturnType<typeof createEcosystemTraffic>;

/** Traffic uses the shared v2 workload transport and temporary IAM credential provider. */
export function startPlatformActivity(ready: () => boolean): EcosystemTraffic {
  const traffic = createEcosystemTraffic({
    service: 'alia-integrations',
    ready,
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
  traffic.installFetch();
  return traffic;
}
