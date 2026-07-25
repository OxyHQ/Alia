export type OxyRequestUser = Record<string, unknown>;
export type OxyServiceAppContext = Record<string, unknown>;

export function createOxyAuthMiddleware() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
}

export function createOptionalOxyAuth() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
}
