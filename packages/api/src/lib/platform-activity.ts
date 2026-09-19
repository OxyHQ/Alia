import { createEcosystemTraffic } from '@oxy.so/core/server';
import { canAuthenticateAsOxyService, oxyServiceToken } from './oxy-service-client.js';

/**
 * Start once per deployed process; local sessions have no infrastructure location.
 *
 * The second guard used to read `OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET`
 * and THROW, which refused to boot exactly the deployment whose identity is
 * strongest: `oxyServiceToken()` mints from the attested task role just as
 * happily (oxy ADR 0026), so a task with the pair removed would have died at
 * boot, been rolled back by the ECS circuit breaker, and reported the service
 * stable — a rollback with nothing naming its cause.
 *
 * It asks the capability now. The refusal is kept rather than deleted because
 * `credential:` is passed: that bypasses the SDK's own equivalent check inside
 * `createEcosystemTraffic`, so a process with no identity would otherwise fail
 * on the first heartbeat instead of at boot, which is the trade this guard was
 * written to make.
 */
export function startPlatformActivity(ready: () => boolean, service = 'alia') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  if (!canAuthenticateAsOxyService()) {
    throw new Error(
      'Ecosystem activity needs an Oxy service identity: either an OXY_SERVICE_API_KEY ' +
        'and OXY_SERVICE_API_SECRET pair, or a workload identity this process can attest ' +
        '(oxy ADR 0026)',
    );
  }
  const traffic = createEcosystemTraffic({
    service,
    ready,
    credential: oxyServiceToken,
  });
  traffic.installFetch();
  return traffic;
}
