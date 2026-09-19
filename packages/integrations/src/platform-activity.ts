import { createEcosystemTraffic } from '@oxy.so/core/server';

export function startPlatformActivity(ready: () => boolean) {
  if (!process.env.OXY_SERVICE_API_KEY?.trim() || !process.env.OXY_SERVICE_API_SECRET?.trim()) return undefined;
  const traffic = createEcosystemTraffic({ service: 'alia-integrations', ready });
  traffic.installFetch();
  return traffic;
}
