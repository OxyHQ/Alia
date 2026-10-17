/**
 * How an Oxy app tool is named in a turn's tool set — the one spelling
 * `buildOxyServiceTools` registers and everything else matches against.
 *
 * A leaf module, so a reader of names never pulls in the tool builder.
 */

/** An app id or a tool name, as it may appear inside a tool name. */
export function sanitizeOxyToolNamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * The names an app tool is registered under, for one identity:
 * `oxy_<app>__<tool>` (the person's account) or `self_<app>__<tool>` (the
 * agent's own), and `…__<suffix>` when one tool is bound to several resources.
 * What a turn holds is matched against these, never parsed back.
 */
export function oxyToolNamesIn(
  names: Iterable<string>,
  identity: 'oxy' | 'self',
  appId: string,
  tool: string,
): string[] {
  const base = `${identity}_${sanitizeOxyToolNamePart(appId)}__${sanitizeOxyToolNamePart(tool)}`;
  return [...names].filter((name) => name === base || name.startsWith(`${base}__`));
}
