/**
 * Build-time preferences for the SDK.
 *
 * These mirror `packages/app/lib/config.ts`, and carry the same warning it does:
 * **a value here is never trusted.** The catalogue carries no default of its own
 * — it orders entries by price and says explicitly that position is not a
 * recommendation — so a build-time value is the only mechanism available for
 * "what should this ask for first". `resolveSelection` then checks it against
 * what the server actually offers and falls through when the catalogue does not
 * list it.
 *
 * Overridable per build so a consumer is not stranded on a retired identifier
 * until the SDK ships a new version, which is the failure the hardcoded
 * `'kaana-v1'` inside `useAliaChat` used to guarantee.
 */

/** What a chat request asks for when the caller names no model. Checked against the catalogue. */
export const PREFERRED_CHAT_MODEL_ID =
  process.env.EXPO_PUBLIC_ALIA_DEFAULT_MODEL ?? 'profile:v1';

/**
 * What speech synthesis and the voice session ask for.
 *
 * **Not resolved against the chat catalogue, and that is deliberate.**
 * `GET /catalogue` describes what a chat PICKER may offer, and
 * `resolveSelection` filters to `chat_visible` entries; a voice identifier is
 * not one of those. Passing this through the chat resolver would replace it with
 * a chat model the moment the catalogue did not list it, and `/v1/audio/speech`
 * would then be asked to synthesize with something that cannot speak — a
 * plausible-looking substitution that fails at the far end, which is worse than
 * the 400 it replaces.
 *
 * So this stays a preference the consumer can override and the server validates.
 * Resolving it properly needs a catalogue that describes voice capability as a
 * first-class filter; that is workstream 5's business, not a thing to fake here.
 */
export const PREFERRED_VOICE_MODEL_ID =
  process.env.EXPO_PUBLIC_ALIA_VOICE_MODEL ?? 'profile:v1-voice';
