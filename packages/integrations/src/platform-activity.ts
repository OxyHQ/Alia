import { createEcosystemTraffic } from '@oxy.so/core/server';
import { oxy } from './shared/oxy.js';

type EcosystemTraffic = ReturnType<typeof createEcosystemTraffic>;

/** Traffic uses the same temporary workload identity as the product transport. */
export function startPlatformActivity(ready: () => boolean): EcosystemTraffic {
  const traffic = createEcosystemTraffic({
    service: 'alia-integrations',
    ready,
    credential: () => oxy.serviceToken(),
  });
  traffic.installFetch();
  return traffic;
}
