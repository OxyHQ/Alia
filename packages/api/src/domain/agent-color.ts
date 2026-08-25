/**
 * The colour an agent is drawn in — proposed here, stored by Oxy.
 *
 * An agent has no avatar any more. What distinguishes one from another on
 * screen is its NAME and its COLOUR, and the colour lives where the name and
 * the handle already do: on the agent's Oxy `bot` account, in `User.color`.
 * Alia stores no column for it, exactly as it stores none for the name.
 *
 * ## Alia PROPOSES a colour and never validates one
 *
 * The vocabulary is Bloom's. `User.color` holds a Bloom preset KEY — `"blue"`,
 * `"lagoon"`, `"bronze-neon"` — not a hex, and Bloom's `FREE_COLOR_NAMES` is
 * the list of the sixty-one a person may pick without a subscription.
 * `@oxyhq/bloom` is a React Native package and is not, and should not become, a
 * dependency of this service, so the names below are a curated SUBSET restated
 * rather than imported.
 *
 * That restatement is only safe because nothing here decides anything: this
 * list is what `POST /agents/generate` may OFFER, and the offer is a
 * suggestion the person then edits. A key Bloom later renames resolves to
 * Bloom's own fallback in every consumer, which is the same thing that happens
 * to an agent whose owner never chose a colour at all. There is deliberately no
 * validation of a STORED colour anywhere in this service — validating against a
 * stale copy of somebody else's vocabulary is how a working colour starts
 * being refused.
 *
 * Premium and reserved presets are excluded on purpose: `PREMIUM_COLOR_NAMES`
 * is sold with a subscription and `HANDLE_COLOR_NAMES` (`oxy`, `faircoin`) are
 * the brands of the accounts that own them. Proposing either would put a colour
 * the owner cannot keep in front of them at the moment they are naming a new
 * agent.
 */

/** Bloom free preset keys, one per hue, that a generated agent may be offered. */
export const AGENT_COLORS = [
  'teal',
  'blue',
  'sky',
  'green',
  'mint',
  'yellow',
  'orange',
  'red',
  'rose',
  'purple',
  'violet',
  'brown',
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

export function isAgentColor(value: unknown): value is AgentColor {
  return typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value);
}

/**
 * A colour for an agent whose generated one was not offerable.
 *
 * Derived from the proposed handle rather than random, so regenerating the same
 * agent twice proposes the same colour and the person is not shown a value that
 * changes under them between two identical requests. The sum is over code
 * units, which is stable across runtimes in a way `Math.random` and hash-map
 * iteration order are not.
 */
export function agentColorFor(seed: string): AgentColor {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum = (sum + seed.charCodeAt(i)) % 1_000_003;
  return AGENT_COLORS[sum % AGENT_COLORS.length];
}
