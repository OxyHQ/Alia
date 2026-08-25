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
 * There is deliberately no validation of a STORED colour anywhere in this
 * service — validating against a stale copy of somebody else's vocabulary is
 * how a working colour starts being refused. What the list below constrains is
 * only what `POST /agents/generate` may OFFER.
 *
 * Premium and reserved presets are excluded on purpose: `PREMIUM_COLOR_NAMES`
 * is sold with a subscription and `HANDLE_COLOR_NAMES` (`oxy`, `faircoin`) are
 * the brands of the accounts that own them. Proposing either would put a colour
 * the owner cannot keep in front of them at the moment they are naming a new
 * agent.
 *
 * ## Why this list is SHORTER than Bloom's, and must stay a subset
 *
 * An offered colour is not a suggestion that dies on screen: it is written to
 * Oxy, and the write is checked. The real catalogue is the CHECK constraint
 * `users_color_check` on the Oxy server's `users` table, rendered from
 * `USER_COLOR_PRESETS` in that repo's schema — eleven keys, of which Bloom
 * knows nine. A key outside it is refused with a 400 at save time, so a colour
 * this service offers but Oxy will not store is an agent whose creation fails
 * for a reason the person never chose.
 *
 * That is not hypothetical: `yellow`, `rose`, `violet` and `brown` were offered
 * here and are absent from the CHECK. They are gone.
 *
 * **So this list is a subset of two vocabularies, and the source of truth for
 * neither.** Do not "complete" it from Bloom's palette — Bloom is the wider of
 * the two and every key it has that the CHECK lacks is a 400. The constraint is
 * append-only, so a key here keeps working; the way to ADD one is to read the
 * server's catalogue first and take the intersection with Bloom again.
 *
 * `amber` is the shape of the opposite mistake: the CHECK accepts it and no
 * Bloom palette contains it, so an agent offered `amber` would save and then
 * render in the fallback colour — reachable from the database, not from the
 * app.
 */

/**
 * Keys that are BOTH a Bloom free preset and a member of the server's
 * `users_color_check` catalogue — the only colours a generated agent may be
 * offered. See the subset rule above before editing.
 */
export const AGENT_COLORS = [
  'teal',
  'blue',
  'sky',
  'green',
  'mint',
  'orange',
  'red',
  'purple',
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
