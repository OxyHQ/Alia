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
 *
 * ## Why these are `route:*` and not `profile:*`
 *
 * Both used to be spelled `profile:cowork` and `profile:research`. Those are
 * Alia's INTERNAL policy ids (`packages/api/src/lib/routing/presets.ts`), and
 * the request boundary refuses them by design: `toRoutingProfile` in
 * `lib/product-modes.ts` accepts only a canonical Kaana `route:*` profile, and
 * `getProductMode` only a `mode:*` product mode — "No compatibility spelling or
 * internal `profile:*` policy id is translated." So the chat preference was
 * never what a request carried: `resolveSelection` found no catalogue entry
 * for it and substituted the cheapest chat-visible one, which meant Cowork
 * silently ran on Instant rather than on its own routing profile, and ran on
 * nothing at all — `400 unknown_routing_profile` — whenever the catalogue
 * could not be read. The browser preference had no resolver in front of it and
 * was refused on every `browser_action`.
 *
 * `route:cowork` is what the server's own Cowork fixture sends
 * (`routes/v1/__tests__/chatFlowFixtures.test.ts`) and what `GET /catalogue`
 * publishes for it. It is not `chat_visible` — Cowork has no picker, this is a
 * surface preset — which is why `resolveSelection` honours a requested entry
 * the catalogue lists at all, not only one it would show.
 */

/** What a chat request asks for when the user has expressed no preference. */
export const PREFERRED_CHAT_MODEL_ID = 'route:cowork';

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
export const PREFERRED_BROWSER_MODEL_ID = 'route:research';
