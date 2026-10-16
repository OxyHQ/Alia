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

/**
 * Tools built from an Oxy app catalog (`lib/tools/oxy-services.ts`).
 *
 * Oxy authorizes each of their calls itself — the person's bearer, or an
 * agent's level, ceiling or `finance` grant and its limits — and that is the
 * whole permission (ADR 0020 §3). The runtime policy (`actions.ts`) reads this
 * mark so it classifies an Oxy call by the catalog's effect, never by its name
 * or by a word in its arguments.
 */
const declaredOxyApp = new WeakSet<object>();

export function declareOxyAppTool<T extends object>(tool: T): T {
  declaredOxyApp.add(tool);
  return tool;
}

export function isOxyAppTool(tool: object): boolean {
  return declaredOxyApp.has(tool);
}
