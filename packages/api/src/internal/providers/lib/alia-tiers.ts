/**
 * The Alia tier vocabulary — the public-facing model family a request is served
 * as, independent of whoever actually serves it.
 *
 * Declared once here rather than inline beside each column. `alia_models.tier`
 * and `model_configs.alia_tier` are the SAME vocabulary read from two directions
 * ("what tier is this Alia identifier" and "which tier does this upstream model
 * serve"), and they were two identical thirteen-value literals — a shape where
 * adding a tier to one and not the other is silent, and the symptom is an
 * identifier that cannot be routed to.
 *
 * `provider-names.ts` is the precedent. The Postgres CHECK on both columns is
 * rendered from THIS tuple, so the database and the TypeScript union cannot
 * drift apart.
 *
 * A THIRD copy survived that unification: `alia-models.ts` kept its own
 * fourteen-value literal, and `v1-image` was the value only it had. The
 * routing table is typed by that union, so the seeder wrote `alia_tier =
 * 'v1-image'` for all five image mappings and the CHECK rendered from this
 * thirteen-value tuple rejected every one, on every boot, for as long as the
 * image tier has existed. `alia-models.ts` now imports this type instead of
 * restating it, which is the only shape in which the two cannot disagree.
 *
 * There were a FOURTH and a FIFTH, both dead and both now deleted, because a
 * copy that constrains nothing is the one most likely to be edited by somebody
 * who believes they are editing this file: `lib/gateway-client.ts` declared
 * `export type AliaTier = string`, imported by nothing, and
 * `packages/shared-types` carried its own fourteen-value union in a workspace
 * no package depended on. That second one had ALREADY diverged in another
 * field — its `ModelCapabilities` was missing `audioTags`, which
 * `synthesize-speech.ts` reads to decide whether a TTS model performs a
 * bracketed cue or reads it aloud — so "promote it to canonical" was never
 * available without first correcting it, and nothing would have said so.
 *
 * Appending to this tuple CHANGES THE DATABASE: ship the `pre` migration
 * widening both CHECKs in the same commit, exactly as `PROVIDER_NAMES` requires
 * (`db/schema/providers.ts` says so at length).
 *
 * ## This is the ROUTING vocabulary, not the alias vocabulary
 *
 * **A tier here does not need an `alia-*` identifier, and several do not have
 * one.** A capability tier is reached by what the caller wants done —
 * `lib/synthesize-speech.ts`, `lib/image-generation.ts`,
 * `routes/agents-avatar.ts`, `routes/canvas/execute.ts` reach theirs by calling
 * `getModelMappingsForTier` directly — not by naming a model, so there is
 * nothing for a caller to send and no `ALIA_MODELS` entry to add. `v1-tts` and
 * `v1-image` are the long-standing examples.
 *
 * The tiers the aliases name are therefore a SUBSET of this tuple, and a proper
 * one. (Deliberately not stated as a count: this tuple grows, and a sentence
 * that has to be edited every time it does is a sentence that will be wrong
 * instead. `ALIA_TIERS.length` and `Object.keys(ALIA_MODELS)` are the answer at
 * any moment; `docs/alias-layer-audit.mdx` records what they were on a date.)
 *
 * **Do not "tidy" an unaliased tier out on the grounds that no alias mentions
 * it.** That reasoning is precisely what left `v1-image` out of this tuple
 * while the routing table was keyed by it, and the cost was five
 * `model_configs` rows refused on every deploy for as long as the image tier
 * existed.
 */

export const ALIA_TIERS = [
  'lite',
  'v1',
  'v1-codea',
  'v1-cowork',
  'v1-browser',
  'v1-vision',
  'v1-audio',
  'v1-tts',
  'v1-sfx',
  'v1-image',
  'v1-multimodal',
  'v1-pro',
  'v1-pro-max',
  'v1-voice',
  'v1-voice-pro',
] as const;

export type AliaTier = (typeof ALIA_TIERS)[number];
