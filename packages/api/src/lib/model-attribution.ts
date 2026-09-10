/**
 * Attribution an open-weight licence REQUIRES be displayed — epic #139
 * workstream 17.
 *
 * ## The collision this resolves
 *
 * Alia's product conceals which upstream operator and which upstream model
 * answered a request. Some open-weight licences require the opposite: naming
 * the publisher or the base model is a CONDITION of serving it. Those two rules
 * meet on exactly one surface, the catalogue, and the meeting is not a conflict
 * to be argued — a licence term wins over a product preference, because the
 * alternative is serving a model on terms it was not offered under.
 *
 * `lib/errors/sanitize.ts` already scopes concealment to product surfaces and
 * names *"attribution required by an open-weight licence"* among the surfaces
 * it must not run on (#139 workstream 20, PR #162). This module is the other
 * half: the thing that scoping made room for. Doing one without the other
 * re-creates the collision in the opposite direction — a rule that permits
 * attribution but nothing that carries any.
 *
 * ## Alia carries attribution; it never composes one
 *
 * The licence record lives with the deployment, in Kaana's catalogue, and so
 * does the model identity the licence covers. Alia takes the whole block or
 * nothing. It must not be assembled here out of what this repository happens to
 * have, because the nearest available string is `ModelMapping.modelId` — a
 * provider model id, which is a DEPLOYMENT ADDRESS rather than a model identity
 * (ADR 0003), and publishing one under an attribution field would be a leak
 * wearing a licence's name. `packages/api/src/lib/catalogue.ts` makes the same
 * refusal for `publisher` and `model`, for the same reason.
 *
 * Nothing sets it today. `ModelMapping` gained an optional `attribution` field
 * in the same change as this module and no route populates it, so every
 * catalogue entry publishes an empty list. The response reports the
 * declared-route count so an empty list can be told apart from a missing
 * mechanism.
 *
 * ## Why `requiresAttribution` is re-checked here
 *
 * It is the invariant that keeps the sanitisation exemption safe. The catalogue
 * gate permits a model identity in this field and nowhere else; what makes that
 * narrow rather than a loophole is that the field may only be populated when a
 * licence REQUIRES the naming. A licence with `requiresAttribution: false`
 * carried in this field would be a provider identity published with no
 * obligation behind it, which is the leak the gate exists to catch, so it is
 * dropped here rather than trusted.
 */

import type { ModelLicense } from '@oxy.so/contracts';

/**
 * One attribution a caller must display, exactly as the licence record states
 * it.
 *
 * `attributedModel` is the model identity the licence covers, in ADR 0003's
 * canonical `<publisher>/<model>` form — the thing the licence requires be
 * named. It is not the deployment that serves it and not the operator that runs
 * it, neither of which a licence asks anybody to display.
 */
export interface RequiredAttribution {
  readonly license: ModelLicense;
  readonly attributedModel: string;
}

/**
 * Whether a carried block is a REQUIRED attribution, as opposed to a licence
 * record that happens to be attached.
 *
 * The empty-string check is not defensive noise: an attribution naming nothing
 * satisfies no licence, and publishing one would report compliance that was not
 * achieved. Better to publish nothing and have the absence be visible.
 */
export function isRequiredAttribution(attribution: RequiredAttribution): boolean {
  return attribution.license.requiresAttribution && attribution.attributedModel.trim() !== '';
}

/**
 * Every distinct attribution a caller of one catalogue entry must display.
 *
 * A routing profile answers from a different model each time and the caller
 * cannot know which, so every route that requires attribution contributes: the
 * obligation is the UNION over the candidate set, not the attribution of
 * whichever route happens to answer.
 *
 * Deduplicated by licence and attributed model — two deployments of one
 * open-weight model produce one notice — and ordered so the response is stable
 * across requests.
 */
export function requiredAttributions(
  attributions: readonly (RequiredAttribution | null)[],
): readonly RequiredAttribution[] {
  const distinct = new Map<string, RequiredAttribution>();
  for (const attribution of attributions) {
    if (attribution === null) continue;
    if (!isRequiredAttribution(attribution)) continue;
    distinct.set(`${attribution.license.licenseId}\u0000${attribution.attributedModel}`, attribution);
  }
  return [...distinct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
