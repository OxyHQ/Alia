import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';

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

/**
 * Traffic reporting, off where this process has no Oxy identity to report as.
 *
 * The condition used to be the presence of `OXY_SERVICE_API_KEY` and
 * `OXY_SERVICE_API_SECRET`, and that stopped being the same question: under oxy
 * ADR 0026 this task attests its ECS role and `@oxy.so/core` >= 1.6.1 mints from
 * that inside `getServiceToken()` whenever no pair is set. Left as it was, taking
 * the pair off the `alia-integrations` task definition would have switched
 * observability off on a service that can authenticate perfectly well — silently,
 * because this returns `undefined` rather than failing, and nothing downstream
 * distinguishes "not reporting" from "no traffic".
 *
 * `undefined` for a checkout is kept and is the reason this asks at all. No
 * `credential:` is passed, so `createEcosystemTraffic` would otherwise THROW
 * there — a local `bun run dev` is not a deployment that forgot a secret.
 */
export function startPlatformActivity(ready: () => boolean): EcosystemTraffic | undefined {
  const hasPair =
    (process.env.OXY_SERVICE_API_KEY ?? '').trim() !== '' &&
    (process.env.OXY_SERVICE_API_SECRET ?? '').trim() !== '';
  if (!hasPair && !canAttestWorkloadIdentity()) return undefined;
  const traffic = createEcosystemTraffic({ service: 'alia-integrations', ready });
  traffic.installFetch();
  return traffic;
}
