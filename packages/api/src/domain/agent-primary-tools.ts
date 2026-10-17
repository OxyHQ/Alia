/**
 * An agent's primary tools: the Oxy app tools its owner says it works with,
 * active from the first step of every turn it leads.
 *
 * Without them a turn with more tools than one request carries defers every
 * app tool behind `loadTools` (`lib/tool-budget.ts`), and an agent whose whole
 * job is one app's tools (Sindi and Homiio's listings) answers from the web
 * because the model never loaded them. The owner names them once; the budget
 * treats them as pins.
 *
 * A key is `<appId>:<tool>` in the catalogue's own spelling — the same key a
 * tool renderer is registered under (`docs/agent-embedding.md` §3). Naming a
 * tool grants nothing: the turn still reaches only what the agent's grants
 * (its owner) or ceilings (anybody else) bind, and a key nothing binds this
 * turn is simply not there.
 *
 * A leaf module: the schema types its column from it and the editor's
 * validator is built from the same constants.
 */

/** The most primary tools an agent declares. A handful fits any request's budget. */
export const MAX_AGENT_PRIMARY_TOOLS = 12;

/** `<appId>:<tool>`, both in the catalogue's spelling. */
export const PRIMARY_TOOL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}:[A-Za-z][A-Za-z0-9_]{0,127}$/;

export interface PrimaryToolKey {
  readonly appId: string;
  readonly tool: string;
}

/** A stored key, or `null` when it is not one. */
export function parsePrimaryToolKey(key: string): PrimaryToolKey | null {
  if (!PRIMARY_TOOL_KEY_PATTERN.test(key)) return null;
  const separator = key.indexOf(':');
  return { appId: key.slice(0, separator), tool: key.slice(separator + 1) };
}
