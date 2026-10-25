import { createEcosystemTraffic } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Publish with the shared v2 workload transport, including temporary IAM roles locally. */
export function startPlatformActivity(ready: () => boolean, service = 'alia') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  const traffic = createEcosystemTraffic({
    service,
    ready,
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
  traffic.installFetch();
  return traffic;
}
