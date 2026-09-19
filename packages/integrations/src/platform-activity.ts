import { createEcosystemTraffic } from '@oxy.so/core/server';

/**
 * What `createEcosystemTraffic` hands back, named through the function itself.
 *
 * The annotation below is load-bearing, not decoration. `build` is `tsc` with
 * declaration emit, and an INFERRED return type here cannot be written into the
 * `.d.ts`: the object's members mention `HttpRequest` and `HttpResponse` from
 * `@oxy.so/telemetry/dist/types/collector`, which is not one of that package's
 * export entries, so there is no name for them to emit (TS4058) and the
 * surrounding type would have to be spelled as a path into `node_modules/.bun/`
 * (TS2742). Both are portability errors and both fail the Docker build — which
 * is where they surface, because that is the only place the package is compiled.
 *
 * Naming it as `ReturnType<typeof createEcosystemTraffic>` sidesteps that
 * without narrowing anything: the alias is expressed in terms of an imported
 * symbol that DOES have a public name, and callers keep every member they use
 * (`observeHttp`, `observeWebSocket`, `stop`).
 */
type EcosystemTraffic = ReturnType<typeof createEcosystemTraffic>;

export function startPlatformActivity(ready: () => boolean): EcosystemTraffic | undefined {
  if (!process.env.OXY_SERVICE_API_KEY?.trim() || !process.env.OXY_SERVICE_API_SECRET?.trim()) return undefined;
  const traffic = createEcosystemTraffic({ service: 'alia-integrations', ready });
  traffic.installFetch();
  return traffic;
}
