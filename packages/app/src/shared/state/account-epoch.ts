/**
 * Which signed-in account the app's in-memory data currently belongs to, as a
 * number that only ever grows.
 *
 * A read that writes its answer into a store as a side effect — the memory
 * document, the library — cannot be un-sent when the account
 * changes, and axios has no idea the person it was asking for has gone. So
 * such a read takes the epoch before it awaits and writes only if the epoch is
 * still the same afterwards: a slow answer for A that lands after the switch
 * to B, or after signing out, is dropped instead of repopulating the screen
 * (#608 §4).
 *
 * Advanced by `resetAccountSession` (`src/shell/account-lifecycle.ts`) and by nothing
 * else.
 */
let epoch = 0;

export function currentAccountEpoch(): number {
  return epoch;
}

export function isCurrentAccountEpoch(taken: number): boolean {
  return taken === epoch;
}

export function advanceAccountEpoch(): void {
  epoch += 1;
}

/** The last account/session projection committed by Alia's mounted shell. */
export type AccountProjection = {
  userId: string | null;
  sessionId: string | null;
  revision: number;
};
let projection: AccountProjection = { userId: null, sessionId: null, revision: 0 };
const projectionListeners = new Set<() => void>();
const invalidationListeners = new Set<() => void>();
let projectionShell: object | null = null;

/** Register the mounted shell without letting an older shell clear a newer one. */
export function bindAccountProjectionShell(shell: object): void {
  projectionShell = shell;
}
export function releaseAccountProjectionShell(shell: object): void {
  if (projectionShell !== shell) return;
  projectionShell = null;
  if (projection.userId === null && projection.sessionId === null) return;
  projection = { userId: null, sessionId: null, revision: projection.revision + 1 };
  // The shell's React subscribers are unmounting. Notifying them here would
  // schedule React updates during insertion cleanup; only abort work in flight.
  for (const listener of invalidationListeners) listener();
}

export function commitAccountProjection(userId: string | null, sessionId: string | null): void {
  const same =
    projection.userId === userId &&
    (projection.sessionId === sessionId || (userId !== null && projection.sessionId === null));
  if (same && projection.sessionId === sessionId) return;
  projection = { userId, sessionId, revision: projection.revision + (same ? 0 : 1) };
  for (const listener of invalidationListeners) listener();
  for (const listener of projectionListeners) listener();
}

export function getAccountProjection(): AccountProjection {
  return projection;
}

export function onAccountProjectionChange(listener: () => void): () => void {
  projectionListeners.add(listener);
  return () => {
    projectionListeners.delete(listener);
  };
}

/** Observe authority changes without scheduling React updates during shell cleanup. */
export function onAccountProjectionInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}
