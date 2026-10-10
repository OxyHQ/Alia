/**
 * Power levels — what a person chooses in Alia instead of a model (ADR 0014).
 *
 * A power level is one of Oxy's routing profiles: a slug with no `/`, sent to
 * Oxy as the request's `routingProfile`. Oxy picks an available model of that
 * level (cheapest first), fails over across the level's models, and names the
 * concrete model that ran on the response. Alia chooses none of that: which
 * model belongs to which level is reviewed catalogue data in Oxy
 * (`oxy/docs/inference/power-levels.md`).
 *
 * The seven slugs are Oxy's fixed vocabulary (seeded with fixed ids in every
 * environment), not a curated list of models: none of them names a model.
 */

export const POWER_LEVELS = ['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra'] as const;
export type PowerLevel = (typeof POWER_LEVELS)[number];

/**
 * What Oxy is asked for: an exact model, or a power level sent as the
 * request's `routingProfile` (Oxy then picks the model and names it on the
 * response).
 */
export type OxyInferenceTarget =
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'routingProfile'; readonly routingProfile: PowerLevel };

/** What a request that names nothing runs on. */
export const DEFAULT_POWER_LEVEL: PowerLevel = 'auto';

export function isPowerLevel(value: unknown): value is PowerLevel {
  return typeof value === 'string' && (POWER_LEVELS as readonly string[]).includes(value);
}

/**
 * The model line of a served reference: `<publisher>/<model>@<revision>` →
 * `<publisher>/<model>`. `null` for no reference, or one that is not a model
 * id (no `/`).
 */
export function modelLineOf(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string') return null;
  const at = reference.indexOf('@');
  const line = (at === -1 ? reference : reference.slice(0, at)).trim();
  return line.includes('/') ? line : null;
}

/**
 * The model a turn is priced and recorded against: the model Oxy says ran,
 * when it said one, otherwise what was requested. For a power level that is
 * the only way to know the price — the level itself has none.
 */
export function servedModelId(
  requested: string,
  servedReference: string | null | undefined,
): string {
  return modelLineOf(servedReference) ?? requested;
}

/**
 * The served reference an AI SDK result carries (`providerMetadata.kaana`,
 * written by `lib/inference/kaana-language-model.ts`), or `null`.
 */
export function servedReferenceOf(result: {
  readonly providerMetadata?: Record<string, Record<string, unknown> | undefined> | undefined;
}): string | null {
  const reference = result.providerMetadata?.kaana?.resolvedModelReference;
  return typeof reference === 'string' && reference !== '' ? reference : null;
}
