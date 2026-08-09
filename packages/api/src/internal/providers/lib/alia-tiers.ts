/**
 * The Alia tier vocabulary — the public-facing model family a request is served
 * as, independent of whoever actually serves it.
 *
 * Declared once here rather than inline in each Mongoose schema. `AliaModel.tier`
 * and `ModelConfig.aliaTier` are the SAME vocabulary read from two directions
 * ("what tier is this Alia model" and "which tier does this provider model
 * serve"), and they were two identical thirteen-value literals — a shape where
 * adding a tier to one and not the other is silent, and the symptom is a model
 * that cannot be routed to.
 *
 * `provider-names.ts` is the precedent. The Postgres CHECK on both columns is
 * rendered from THIS tuple too, so the database, the two Mongoose enums and the
 * TypeScript union cannot drift apart while both stores exist.
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
  'v1-multimodal',
  'v1-pro',
  'v1-pro-max',
  'v1-voice',
  'v1-voice-pro',
] as const;

export type AliaTier = (typeof ALIA_TIERS)[number];
