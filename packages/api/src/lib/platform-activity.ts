import { createEcosystemTraffic } from '@oxy.so/core/server';
import { oxyServiceToken } from './oxy-service-client.js';

/** Start once per deployed process; local sessions have no infrastructure location. */
export function startPlatformActivity(ready: () => boolean, service = 'alia') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  if (!process.env.OXY_SERVICE_API_KEY?.trim() || !process.env.OXY_SERVICE_API_SECRET?.trim()) {
    throw new Error('Ecosystem activity requires the configured Oxy service credential');
  }
  const traffic = createEcosystemTraffic({
    service,
    ready,
    credential: oxyServiceToken,
  });
  traffic.installFetch();
  return traffic;
}
