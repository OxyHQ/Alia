/**
 * The Alia tier vocabulary — the public-facing model family a request is served
 * as, independent of whoever actually serves it.
 *
 * Declared once here rather than inline beside each column. It rendered CHECKs
 * on TWO columns — `routing_profiles.tier` and `model_configs.alia_tier` — and they
 * were two identical thirteen-value literals, a shape where adding a tier to one
 * and not the other is silent and the symptom is an identifier that cannot be
 * routed to.
 *
 * **`model_configs.alia_tier` is gone**, dropped by
 * `0049_the_tier_column_cannot_be_correct`: a row there is one
 * `(provider, model_id)` pair, the routing table maps that pair to many tiers,
 * and one column over a many-to-many relation records only whichever tier was
 * written last. So `routing_profiles.tier` is now the single column this tuple
 * constrains — but the tuple is still the routing vocabulary and still keys
 * `GENERATED_TIER_MAPPINGS`, which is where a tier is reachable from whether or
 * not any row names it.
 *
 * `provider-names.ts` is the precedent. The Postgres CHECK is rendered from THIS
 * tuple, so the database and the TypeScript union cannot drift apart.
 *
 * A THIRD copy survived that unification: `routing-profile-catalogue.ts` kept its own
 * fourteen-value literal, and `v1-image` was the value only it had. The
 * routing table is typed by that union, so the seeder wrote `alia_tier =
 * 'v1-image'` for all five image mappings and the CHECK rendered from this
 * thirteen-value tuple rejected every one, on every boot, for as long as the
 * image tier has existed. `routing-profile-catalogue.ts` now imports this type instead of
 * restating it, which is the only shape in which the two cannot disagree.
 *
 * There were a FOURTH and a FIFTH, both dead and both now deleted, because a
 * copy that constrains nothing is the one most likely to be edited by somebody
 * who believes they are editing this file: `lib/gateway-client.ts` declared
 * `export type RoutingTier = string`, imported by nothing, and
 * `packages/shared-types` carried its own fourteen-value union in a workspace
 * no package depended on. That second one had ALREADY diverged in another
 * field — its `ModelCapabilities` was missing `audioTags`, which
 * `synthesize-speech.ts` reads to decide whether a TTS model performs a
 * bracketed cue or reads it aloud — so "promote it to canonical" was never
 * available without first correcting it, and nothing would have said so.
 *
 * Appending to this tuple CHANGES THE DATABASE: ship the `pre` migration
 * widening `routing_profiles_tier_check` in the same commit, exactly as
 * `PROVIDER_NAMES` requires (`db/schema/providers.ts` says so at length).
 *
 * ## This is the ROUTING vocabulary, not the alias vocabulary
 *
 * **A tier here does not need an `alia-*` identifier, and several do not have
 * one.** A capability tier is reached by what the caller wants done —
 * `lib/synthesize-speech.ts`, `lib/image-generation.ts` and
 * `routes/canvas/execute.ts` reach theirs by calling
 * `getModelMappingsForTier` directly — not by naming a model, so there is
 * nothing for a caller to send and no `KAANA_ROUTING_PROFILES` entry to add. `v1-tts` and
 * `v1-image` are the long-standing examples.
 *
 * The tiers the aliases name are therefore a SUBSET of this tuple, and a proper
 * one. (Deliberately not stated as a count: this tuple grows, and a sentence
 * that has to be edited every time it does is a sentence that will be wrong
 * instead. `ROUTING_TIERS.length` and `Object.keys(KAANA_ROUTING_PROFILES)` are the answer at
 * any moment; `docs/alias-layer-audit.mdx` records what they were on a date.)
 *
 * **Do not "tidy" an unaliased tier out on the grounds that no alias mentions
 * it.** That reasoning is precisely what left `v1-image` out of this tuple
 * while the routing table was keyed by it, and the cost was five
 * `model_configs` rows refused on every deploy for as long as the image tier
 * existed. A tier with no alias also has no `routing_profiles` row, so since the
 * `model_configs` column was dropped NOTHING in the database mentions such a
 * tier at all — which makes the tuple the only record that it exists, and an
 * unaliased tier correspondingly easier to delete by mistake.
 */

export const ROUTING_TIERS = [
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

export type RoutingTier = (typeof ROUTING_TIERS)[number];
