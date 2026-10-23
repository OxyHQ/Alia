/** Session streams remain inside the authenticated internal account namespace. */
export function maySubscribe(ownerUserId: string, sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  const separator = sessionId.indexOf(':');
  if (separator <= 0) return false;
  return sessionId.slice(0, separator) === ownerUserId;
}
