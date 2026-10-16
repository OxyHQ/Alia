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

/**
 * REAL, for the same reason as `createOxyCors`: which app a request comes from
 * (ADR 0021) is decided by the assertion's verification, which is the subject
 * of `lib/__tests__/app-confined-agents.test.ts`. A stub would pass with the
 * signature, the session binding and the issuer checks deleted.
 */
export const readAppAssertionHeader: OxyCoreServer['readAppAssertionHeader'] =
  real.readAppAssertionHeader;
export const verifyAppAssertion: OxyCoreServer['verifyAppAssertion'] = real.verifyAppAssertion;
export const signOxyAppAssertion: OxyCoreServer['signOxyAppAssertion'] = real.signOxyAppAssertion;

/**
 * REAL: `OxyServer` is the API's Oxy client itself (`middleware/auth.ts`,
 * `lib/oxy-service-client.ts`), constructed at import. Constructing it reaches
 * no network; only its calls do, and those are what tests stub.
 */
export const OxyServer: OxyCoreServer['OxyServer'] = real.OxyServer;
export type OxyServer = InstanceType<OxyCoreServer['OxyServer']>;

/** Machine credential tests use the real resource boundary, never an auth stub. */
export const createOxyAliaMachineCredentialAuth = real.createOxyAliaMachineCredentialAuth;
export const getOxyAliaMachineCredentialBearer = real.getOxyAliaMachineCredentialBearer;
export type OxyAliaMachinePrincipal = import('@oxy.so/core/server').OxyAliaMachinePrincipal;

/**
 * Oxy's file-event signature check (oxy ADR 0041 D9) is REAL, for the reason
 * the lanes above are: verifying the signature, the replay window and the
 * challenge IS the subject of `routes/__tests__/oxy-files-webhook.test.ts`, and
 * a stub would let that suite pass with every check deleted.
 */
export const verifyFileEventSignature: OxyCoreServer['verifyFileEventSignature'] =
  real.verifyFileEventSignature;
export const FileEventVerificationError: OxyCoreServer['FileEventVerificationError'] =
  real.FileEventVerificationError;
export type FileEvent = import('@oxy.so/core/server').FileEvent;
