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
 * Appending to this tuple CHANGES THE DATABASE: ship the `pre` migration
 * widening both CHECKs in the same commit, exactly as `PROVIDER_NAMES` requires
 * (`db/schema/providers.ts` says so at length).
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
  'v1-image',
  'v1-multimodal',
  'v1-pro',
  'v1-pro-max',
  'v1-voice',
  'v1-voice-pro',
] as const;

export type AliaTier = (typeof ALIA_TIERS)[number];
