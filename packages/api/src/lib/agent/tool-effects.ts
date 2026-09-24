/**
 * Tools whose SOURCE declared them read-only.
 *
 * A name cannot say this — `oxy_inbox__list_threads` and
 * `oxy_inbox__send_message` share a prefix — but the catalog that built the
 * tool knows its effect exactly, so the builder marks the tool object and the
 * policy reads the mark.
 */
const declaredReadOnly = new WeakSet<object>();

export function declareReadOnly<T extends object>(tool: T): T {
  declaredReadOnly.add(tool);
  return tool;
}

export function isDeclaredReadOnly(tool: object): boolean {
  return declaredReadOnly.has(tool);
}
