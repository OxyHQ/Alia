/**
 * What the caller asked for, classified — epic #139 workstream 5, *"Record the
 * requested model/profile and actual resolved model revision in product
 * analytics without leaking unsafe provider details to end users."*
 *
 * ## Why an identifier alone is not the answer
 *
 * `body.model` is ONE string carrying three different kinds of request, and
 * they are not comparable:
 *
 *  - a **routing profile** — `kaana-v1-pro`, what the picker sends;
 *  - a **concrete model** — `<publisher>/<model>[@<revision>]`, ADR 0003's
 *    canonical reference, what a caller who wants exactly those weights sends;
 * Storing the string and nothing else makes `kaana-v1-pro` and `qwen/qwen3-32b`
 * two rows of the same column and invites every later query to treat them as
 * two model choices. They are a product mode wearing a model's name and a model.
 * Reading them as the same thing IS the conflation this epic is removing, so the
 * SHAPE is recorded beside the string and a query that wants product modes can
 * ask for product modes.
 *
 * ## Reasoning is a parameter, not a model
 *
 * `kaana-v1-thinking` and `kaana-v1-pro-max` are one routing preset with two names
 * (`lib/routing/presets.ts`: "Two identifiers, one policy"), and the difference
 * between them is a reasoning setting. So the reasoning request is lifted out
 * into {@link reasoningEffortOf} and recorded in its own column, from BOTH the
 * places a caller can express it — the `thinkingMode` flag and the dedicated
 * routing profile. Without the lift,
 * "how many people asked for extended reasoning" is a question answerable only
 * by knowing which model identifiers secretly meant it.
 *
 * ## What this does NOT decide
 *
 * Nothing here routes. `resolveRoutingTarget` owns what a request becomes; this
 * reads the same identifier a second time to say what it
 * WAS. An identifier neither recognises is `unregistered` rather than an error:
 * an analytics write must not be able to fail a request, and "the caller asked
 * for something we do not serve" is itself a fact worth counting.
 */

import { modelReferenceSchema } from '@oxyhq/contracts';

import { isEffortLevel, type EffortLevel } from '../reasoning-effort.js';
import { isKaanaRoutingProfileId } from '../routing/kaana-profiles.js';

/**
 * The three shapes a request can name, plus the answer for one that names none.
 *
 * `unregistered` is a real outcome and not an error bucket: a client pinned to
 * an identifier nobody serves is exactly what a migration wants to see the size
 * of.
 */
export type RequestedModelKind =
  | 'routing_profile'
  | 'model_reference'
  | 'unregistered';

export interface RequestedModelIdentity {
  /** Verbatim, as the caller sent it. */
  readonly id: string;
  readonly kind: RequestedModelKind;
  /**
   * The canonical Kaana routing profile this request selects. Null for a
   * concrete model reference and for an identifier nothing recognises.
   */
  readonly profileId: string | null;
}

/**
 * Classify one requested identifier.
 *
 * The profile set is exact: a well-formed slug is not automatically a profile
 * this product is allowed to request.
 */
export function classifyRequestedModel(requested: string): RequestedModelIdentity {
  if (isKaanaRoutingProfileId(requested)) {
    return { id: requested, kind: 'routing_profile', profileId: requested };
  }

  // The contract's own grammar, not a hand-written one: `<publisher>/<model>`
  // and its revision-pinned form are ADR 0003's, and restating the regex here
  // would be a second copy free to disagree with the wire.
  if (modelReferenceSchema.safeParse(requested).success) {
    return { id: requested, kind: 'model_reference', profileId: null };
  }

  return { id: requested, kind: 'unregistered', profileId: null };
}

/**
 * How hard the caller asked this request to think, or `null` for the model's
 * own default.
 *
 * ## One computation, both consumers
 *
 * This used to answer only for ANALYTICS, while `lib/chat/model-config.ts`
 * decided independently whether to send a provider option — two readings of the
 * same intent, kept in step by `__tests__/reasoning-effort-agreement.test.ts`
 * asserting they agreed. They agree by construction now: the level computed
 * here is the one written to `chat_analytics.reasoning_effort` AND the one
 * handed to the request builder, so a request cannot be billed and recorded as
 * reasoning while sending nothing, or the reverse.
 *
 * ## Three inputs, because a caller has three ways to say it
 *
 *  - `reasoningEffort` on the request body — the parameter, and the only one
 *    that can name a level above the first;
 *  - `thinkingMode: true`, the boolean this replaced. It stays READ, though
 *    nothing in this repository writes it any more: it is a documented field of
 *    the public `/v1/chat/completions` shape that every published
 *    `@alia.onl/sdk` and `@alia-codea/cli` copy in the wild still sends, and
 *    ADR 0004 keeps that surface serving its existing request shape. This one
 *    function is the whole compatibility surface — nothing downstream carries a
 *    boolean;
 *  - `kaana-v1-thinking`, which is the same parameter wearing a model's name.
 *
 * The two legacy spellings mean `medium`, and not a higher level: both meant
 * "reason" against a code path that sent NO budget at all, so mapping them to
 * the smallest budget the product offers is the reading that cannot raise
 * anybody's bill without them asking. An explicit `reasoningEffort` wins over
 * either.
 */
export type ReasoningEffort = EffortLevel;

export function reasoningEffortOf(input: {
  readonly reasoningEffort?: unknown;
  readonly thinkingMode?: boolean;
  readonly requestedModel: string;
}): ReasoningEffort | null {
  if (isEffortLevel(input.reasoningEffort)) return input.reasoningEffort;
  if (input.thinkingMode === true) return COMPAT_REASONING_LEVEL;
  return input.requestedModel === THINKING_PROFILE ? COMPAT_REASONING_LEVEL : null;
}

/** What boolean-era reasoning requests mean on the graded scale. */
const COMPAT_REASONING_LEVEL: EffortLevel = 'medium';

/**
 * The canonical Kaana profile whose product meaning includes reasoning.
 *
 * Asserted against `ROUTING_PRESETS` in `__tests__/requested-model.test.ts`
 * rather than trusted: it shares a preset with `kaana-v1-pro-max`, and if that
 * ever stops being true this constant is naming a model instead of a setting.
 */
const THINKING_PROFILE = 'kaana-v1-thinking';
