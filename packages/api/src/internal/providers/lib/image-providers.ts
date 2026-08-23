/**
 * Image Provider Knowledge
 *
 * Internal, provider-specific knowledge for image generation — the sibling of
 * `tts-providers.ts`, and it exists for the same reason: the product route
 * builds ONE request and every provider wants a slightly different one.
 *
 * `POST /v1/images/generations` is an OpenAI-shaped endpoint, and providers
 * implement the shape they need rather than all of it. Sending OpenAI's full
 * parameter set to a provider that implements a subset does not degrade — it
 * fails the whole request.
 *
 * MEASURED against xAI on 2026-08-23, one parameter at a time against a live
 * key, because the failure is per-parameter and the response body is EMPTY:
 *
 * | body                                       | xAI  |
 * |--------------------------------------------|------|
 * | `model` + `prompt`                         | 200  |
 * | ... + `n`                                  | 200  |
 * | ... + `response_format`                    | 200  |
 * | ... + `size`                               | 400  |
 * | ... + `quality`                            | 422  |
 *
 * So the route's own body — which carries all four — is refused by every one of
 * xAI's three image models, while the same prompt with two fields removed
 * returns an image. A mapping added without this translation would look correct
 * in the table and fail on every request.
 *
 * Keep provider names out of anything user-facing — this module is internal only.
 */

/** What the product route knows it wants, in OpenAI's vocabulary. */
export interface ImageRequest {
  modelId: string;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  responseFormat: string;
}

/**
 * Parameters a provider does NOT accept, keyed by provider.
 *
 * An omission list rather than an allow-list, deliberately: a provider absent
 * from this table gets the full OpenAI body, which is the behaviour every
 * existing mapping already relies on. An allow-list would silently strip
 * parameters from providers nobody has measured, turning an untested provider
 * into a quietly degraded one instead of an unchanged one.
 *
 * A `Map` rather than an object literal: the lookup key is a provider name that
 * arrives at runtime, and an object literal read that way walks `Object.prototype`.
 */
const UNSUPPORTED_PARAMS = new Map<string, readonly string[]>([
  ['xai', ['size', 'quality']],
]);

/**
 * The request body for one provider's image endpoint.
 *
 * Returns a plain object rather than mutating a shared one so two providers
 * tried in the same failover loop cannot see each other's edits.
 */
export function imageRequestBody(provider: string, request: ImageRequest): Record<string, unknown> {
  const full: Record<string, unknown> = {
    model: request.modelId,
    prompt: request.prompt,
    n: request.n,
    size: request.size,
    quality: request.quality,
    response_format: request.responseFormat,
  };

  // A `Map` and a filter, not a `Record` and `delete body[param]`. Both of those
  // are reads keyed by a runtime string, which `__tests__/prototype-keyed-lookups.test.ts`
  // flags — a `Map` has no prototype chain to walk into, and building by
  // selection means no dynamic write either. Same result, nothing to exempt.
  const omitted = UNSUPPORTED_PARAMS.get(provider) ?? [];
  return Object.fromEntries(Object.entries(full).filter(([key]) => !omitted.includes(key)));
}
