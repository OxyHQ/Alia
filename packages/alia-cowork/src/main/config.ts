/**
 * Cowork's build-time model preferences.
 *
 * Two identifiers, and the reason there are two is the same reason the SDK has
 * two: one names what a CHAT request asks for first, the other names a
 * CAPABILITY the chat catalogue does not describe.
 *
 * Both carry the standard warning — **never trusted.** The catalogue carries no
 * default of its own, so a build-time value is the only mechanism for "ask for
 * this first", and `resolveSelection` in `./catalogue` checks it against what
 * the server offers before anything is sent.
 *
 * `scripts/check-model-defaults.mjs` permits this module exactly two identifiers
 * and forbids every other module in the package from naming any, by exact count.
 */

/** What a chat request asks for when the user has expressed no preference. */
export const PREFERRED_CHAT_MODEL_ID = 'profile:v1-cowork';

/**
 * The model the browser-automation agent drives Stagehand with.
 *
 * **Not resolved against the chat catalogue, deliberately.** `GET /catalogue`
 * describes what a chat picker may offer and `resolveSelection` filters to
 * `chat_visible` entries; a browser-automation specialist is not one of those.
 * Passing this through the chat resolver would substitute an ordinary chat model
 * the moment the catalogue did not list it, and Stagehand would then be asked to
 * drive a browser with something that cannot — a plausible substitution that
 * fails far from its cause, which is worse than the error it replaces.
 *
 * Resolving it properly needs a catalogue that describes capability as a
 * first-class filter. That is workstream 5's business, not something to fake
 * here.
 */
export const PREFERRED_BROWSER_MODEL_ID = 'profile:v1-browser';
