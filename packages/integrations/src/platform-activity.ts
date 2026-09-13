import { createEcosystemTraffic } from '@oxy.so/core/server';

export function startPlatformActivity(ready: () => boolean) {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  const traffic = createEcosystemTraffic({ service: 'alia-integrations', ready });
  traffic.installFetch();
  return traffic;
}
