import { createRequire } from 'node:module';

export type OxyRequestUser = Record<string, unknown>;
export type OxyServiceAppContext = Record<string, unknown>;

export function createOxyAuthMiddleware() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
}

export function createOptionalOxyAuth() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
}

/**
 * `createOxyCors` is the REAL implementation, not a stub, and it is reached
 * through `createRequire` on purpose.
 *
 * `vitest.config.ts` aliases `@oxy.so/core/server` to this file so tests can
 * mount routers without standing up authentication. A CORS test run against a
 * stubbed matcher would measure the stub — the matching rule is the whole
 * subject of `corsOrigins.test.ts`, including the regression gate for the
 * repaired opaque-origin handling. Vite rewrites the specifier in
 * any `import`, including `vi.importActual`, so the only way back to the
 * package from inside its own alias target is Node's resolver, which knows
 * nothing about the alias.
 *
 * The auth stubs above stay stubs: nothing here needs them to be real.
 */
type OxyCoreServer = typeof import('@oxy.so/core/server');

const real: OxyCoreServer = createRequire(import.meta.url)('@oxy.so/core/server');

export const createOxyCors: OxyCoreServer['createOxyCors'] = real.createOxyCors;

/**
 * The present-requester assertion lane (ADR 0025 in OxyHQServices) is REAL
 * here, for the same reason `createOxyCors` is: the verification IS the subject
 * of `middleware/__tests__/requester-assertion.test.ts`, and a stub would let
 * that suite pass with the checks deleted.
 */
export const createOxyRequesterAssertionAuth: OxyCoreServer['createOxyRequesterAssertionAuth'] =
  real.createOxyRequesterAssertionAuth;
export const OXY_REQUESTER_ASSERTION_HEADER: OxyCoreServer['OXY_REQUESTER_ASSERTION_HEADER'] =
  real.OXY_REQUESTER_ASSERTION_HEADER;
export const signOxyRequesterAssertion: OxyCoreServer['signOxyRequesterAssertion'] =
  real.signOxyRequesterAssertion;
export type OxyRequesterContext = import('@oxy.so/core/server').OxyRequesterContext;

/**
 * REAL, and for the third time in this file the same reason: the behaviour is
 * the subject.
 *
 * `canAttestWorkloadIdentity` is what decides whether a process still needs
 * `OXY_SERVICE_API_KEY` / `_SECRET` (oxy ADR 0026), so the boot guard, the
 * delegation lane and the identity client all turn on it. A stub returning a
 * constant would let every one of those suites pass against a guard that refuses
 * exactly the deployment it is supposed to allow — which is the failure the
 * whole change exists to avoid.
 *
 * Nothing is lost by keeping it real: it reads two environment variables and
 * reaches no network, so a test controls it by setting them.
 */
export const canAttestWorkloadIdentity: OxyCoreServer['canAttestWorkloadIdentity'] =
  real.canAttestWorkloadIdentity;
