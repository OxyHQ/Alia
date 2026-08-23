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
 * `vitest.config.ts` aliases `@oxyhq/core/server` to this file so tests can
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
type OxyCoreServer = typeof import('@oxyhq/core/server');

const real: OxyCoreServer = createRequire(import.meta.url)('@oxyhq/core/server');

export const createOxyCors: OxyCoreServer['createOxyCors'] = real.createOxyCors;
