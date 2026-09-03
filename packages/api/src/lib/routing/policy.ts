/**
 * Fallback policy — a property of ONE request, not a global setting.
 *
 * ADR 0003 invariant 3: substituting one model for another is only permitted
 * when the caller selected a routing profile that allows it or set an explicit
 * fallback policy that allows it. This module is the type that carries that
 * decision from the request body down to the resolver, plus the two refusals
 * that become product-visible when a policy forbids what the engine would
 * otherwise have done silently.
 *
 * ## The default is TODAY's behaviour and does not change here
 *
 * `DEFAULT_FALLBACK_POLICY` is `'cross-model'`, which is exactly what the
 * fallback engine has always done: walk the profile's ranked candidate list
 * across publishers until one answers. ADR 0003 consequence 6 accepts that some
 * requests will fail once that default flips, and flipping it is a product
 * decision for the epic owner — not a side effect of the change that made the
 * policy expressible. Every caller that passes no policy gets the old path.
 *
 * ## Why these three and not more
 *
 * The three names come from #139 workstream 14 and from ADR 0003 invariant 3,
 * which names `no fallback` and `same model only` as supported policies.
 *
 *  - **`no-fallback`** — the profile's top-ranked candidate, or nothing. One
 *    deployment, one attempt at resolution.
 *  - **`same-model-only`** — other deployments of the SAME model, which ADR 0003
 *    invariant 4 says changes nothing a caller can observe about model identity.
 *  - **`cross-model`** — the whole ranked list, publishers included.
 *
 * There is deliberately no `same-publisher` policy. Publisher is not recoverable
 * from this repository's data at all: the mapping table stores a bare provider
 * model id with no publisher segment, which is the finding
 * `docs/migration/alias-migration-map.json` records rather than works around.
 * Inventing an attribution here would be a guess wearing a policy's name.
 */

import { AliaError, AliaErrorCode } from '../errors/error-codes.js';
import { redactUnsafeDetail, sanitizeMessage } from '../errors/sanitize.js';

/**
 * Every fallback policy, in widening order. The order is load-bearing for
 * reading the file, not for any comparison: nothing below treats these as
 * ordered, because "wider" is not the same as "permits everything the narrower
 * one permits" once a preset can pin a policy.
 */
export const FALLBACK_POLICIES = ['no-fallback', 'same-model-only', 'cross-model'] as const;

export type FallbackPolicy = (typeof FALLBACK_POLICIES)[number];

/**
 * What the fallback engine does when nobody says otherwise.
 *
 * Changing this constant is the default flip ADR 0003 describes. It is one
 * line, and it is guarded by a test asserting the value rather than asserting
 * "some policy is the default" — so the flip cannot happen by accident, and
 * whoever makes it has to state it in a diff.
 */
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = 'cross-model';

/**
 * The version of the routing-policy configuration that answered a request.
 *
 * Included in the routing configuration handed to the policy owner so changes
 * remain attributable after the preset table changes. It is an opaque
 * integer, bumped whenever `ROUTING_PRESETS` or `DEFAULT_FALLBACK_POLICY`
 * changes meaning — pinned by a digest in `routing-policy.test.ts`, so editing
 * the table without bumping the version fails there rather than silently
 * making every historical row's version a lie.
 */
export const ROUTING_POLICY_VERSION = 1;

/**
 * Is this a fallback policy? Narrows an unknown request-body value.
 *
 * Deliberately strict: no trimming, no case folding, no aliases. A caller who
 * sends `"No-Fallback"` gets a refusal naming the three accepted values, which
 * is a better outcome than being quietly widened to `cross-model` — the exact
 * shape of failure this workstream exists to remove.
 */
export function isFallbackPolicy(value: unknown): value is FallbackPolicy {
  return typeof value === 'string' && (FALLBACK_POLICIES as readonly string[]).includes(value);
}

/**
 * A model identifier nobody registered reached a resolver.
 *
 * Before strict refusal, the legacy resolver answered such a request from
 * `kaana-v1` and reported the requested name back to the caller. That is ADR
 * 0003 invariant 2 failing in the plainest way, and it is the one behaviour on
 * this page that is NOT preserved: an identifier nobody registered was never a
 * working request, so there is nothing to preserve.
 *
 * ## The echo is the caller's own text, so it comes back readable
 *
 * The requested identifier is echoed back because a refusal that does not say
 * what it refused is not actionable. The commonest wrong value is a provider's
 * own model id — an OpenAI-compatible client pointed at `/v1` sends whatever it
 * was configured with — and telling that caller `"gpt-4o" is not a Kaana routing profile`
 * is the whole point of the message.
 *
 * The echo therefore takes `redactUnsafeDetail`, not `sanitizeMessage`. Route
 * concealment protects Alia's ROUTING decisions on the product surface
 * (`lib/errors/sanitize.ts`), and a string the caller just sent reveals none of
 * them; running it here only produced `"Alia4o" is not a Kaana routing profile`. What
 * still applies is the absolute half — a caller can put a credential in that
 * field, and a credential is redacted wherever it appears.
 */
export class UnregisteredModelError extends AliaError {
  constructor(
    readonly requested: string,
    readonly available: readonly string[],
  ) {
    const detail = `"${requested}" is not a Kaana routing profile. Available models: ${[...available].sort().join(', ')}.`;
    super({
      code: AliaErrorCode.INVALID_REQUEST,
      message: `Unregistered model identifier: ${requested}`,
      userMessage: redactUnsafeDetail(detail),
      retryable: false,
      // `format` is the FailoverReason for "would fail again" — the fallback
      // engine's own NON_RETRYABLE_REASONS set. Retrying elsewhere cannot help:
      // the identifier names nothing anywhere.
      reason: 'format',
      httpStatus: 400,
    });
    this.name = 'UnregisteredModelError';
  }
}

/**
 * The selected model could not be served and the request's policy does not
 * permit answering from a different one.
 *
 * Only reachable under a policy the caller opted into: under
 * `DEFAULT_FALLBACK_POLICY` the engine exhausts the whole ranked list exactly
 * as before and returns `null`, which every existing caller already turns into
 * its own "no models available" response. So this class adds a failure mode
 * without changing any existing one.
 */
export class FallbackNotPermittedError extends AliaError {
  constructor(
    readonly requested: string,
    readonly policy: FallbackPolicy,
  ) {
    const detail =
      policy === 'no-fallback'
        ? `"${requested}" is unavailable right now, and this request asked for no fallback. Retry, or allow fallback to another model.`
        : `"${requested}" is unavailable on every deployment right now, and this request asked to stay on the same model. Retry, or allow fallback to another model.`;
    super({
      code: AliaErrorCode.MODEL_UNAVAILABLE,
      message: `Model unavailable under fallback policy "${policy}": ${requested}`,
      userMessage: sanitizeMessage(detail),
      retryable: true,
      reason: 'provider_unavailable',
      httpStatus: 503,
    });
    this.name = 'FallbackNotPermittedError';
  }
}

/**
 * A caller named something that is not a fallback policy.
 *
 * Separate from `UnregisteredModelError` because the two are different mistakes
 * with different fixes, and collapsing them would tell a caller who mistyped a
 * policy to go and look at the model list.
 *
 * The echo follows the same rule as `UnregisteredModelError`'s: it is the
 * caller's own value, so only `redactUnsafeDetail` applies to it.
 */
export class UnknownFallbackPolicyError extends AliaError {
  constructor(readonly requested: unknown) {
    super({
      code: AliaErrorCode.INVALID_REQUEST,
      message: `Unknown fallback policy: ${String(requested)}`,
      userMessage: redactUnsafeDetail(
        `"${String(requested)}" is not a fallback policy. Accepted values: ${FALLBACK_POLICIES.join(', ')}.`,
      ),
      retryable: false,
      reason: 'format',
      httpStatus: 400,
    });
    this.name = 'UnknownFallbackPolicyError';
  }
}
