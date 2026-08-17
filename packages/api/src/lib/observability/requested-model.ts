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
 *  - a **product mode** — `profile:v1-pro`, what the picker sends;
 *  - a **concrete model** — `<publisher>/<model>[@<revision>]`, ADR 0003's
 *    canonical reference, what a caller who wants exactly those weights sends;
 *  - a **legacy alias** — one of the thirteen `alia-*` identifiers, which come
 *    off every advertised surface but keep resolving, so an installed client
 *    goes on sending one for as long as it is installed.
 *
 * Storing the string and nothing else makes `alia-v1-pro` and `qwen/qwen3-32b`
 * two rows of the same column and invites every later query to treat them as
 * two model choices. They are a product mode wearing a model's name and a model.
 * Reading them as the same thing IS the conflation this epic is removing, so the
 * SHAPE is recorded beside the string and a query that wants product modes can
 * ask for product modes.
 *
 * ## Reasoning is a parameter, not a model
 *
 * `alia-v1-thinking` and `alia-v1-pro-max` are one routing preset with two names
 * (`lib/routing/presets.ts`: "Two identifiers, one policy"), and the difference
 * between them is a reasoning setting. So the reasoning request is lifted out
 * into {@link reasoningEffortOf} and recorded in its own column, from BOTH the
 * places a caller can express it — the `thinkingMode` flag and the alias — and
 * the alias's model half is then just the profile it selects. Without the lift,
 * "how many people asked for extended reasoning" is a question answerable only
 * by knowing which model identifiers secretly meant it.
 *
 * ## What this does NOT decide
 *
 * Nothing here routes. `translateAlias` and `resolveRoutingTarget` own what a
 * request becomes; this reads the same identifier a second time to say what it
 * WAS. An identifier neither recognises is `unregistered` rather than an error:
 * an analytics write must not be able to fail a request, and "the caller asked
 * for something we do not serve" is itself a fact worth counting.
 */

import { modelReferenceSchema, routingProfileSlugSchema } from '@oxyhq/contracts';

import { ROUTING_PRESETS } from '../routing/presets.js';
import { translateAlias } from '../routing/alias-translation.js';

/** The namespace marker Alia's flat id space uses for a product mode. */
const PROFILE_ID_PREFIX = 'profile:';

const KNOWN_PROFILE_IDS: ReadonlySet<string> = new Set(ROUTING_PRESETS.map((preset) => preset.id));

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
  | 'legacy_alias'
  | 'unregistered';

export interface RequestedModelIdentity {
  /** Verbatim, as the caller sent it. */
  readonly id: string;
  readonly kind: RequestedModelKind;
  /**
   * The product mode this request selects, `profile:<tier>`.
   *
   * Present for a product mode and for a legacy alias — which is the whole
   * point: the two are the SAME choice expressed in two eras, and a query that
   * groups on this column sees them together without having to know the
   * migration map. Null for a concrete model reference, which selects no
   * profile, and for an identifier nothing recognises.
   */
  readonly profileId: string | null;
}

/**
 * Classify one requested identifier.
 *
 * Order matters and is not arbitrary: the alias table is consulted FIRST,
 * because `alia-v1-pro` is a well-formed routing-profile slug and a
 * grammar-first reading would classify all thirteen aliases as product modes
 * that Relay has never heard of.
 */
export function classifyRequestedModel(requested: string): RequestedModelIdentity {
  const translation = translateAlias(requested);
  if (translation.kind === 'translated') {
    return { id: requested, kind: 'legacy_alias', profileId: translation.translation.profileId };
  }
  if (translation.kind === 'unregistered_alias') {
    return { id: requested, kind: 'unregistered', profileId: null };
  }

  if (requested.startsWith(PROFILE_ID_PREFIX)) {
    const slug = requested.slice(PROFILE_ID_PREFIX.length);
    // Well-formed AND known. A slug this service does not serve is
    // `unregistered`, so "a product mode was requested" cannot be satisfied by a
    // caller inventing one.
    const known = routingProfileSlugSchema.safeParse(slug).success && KNOWN_PROFILE_IDS.has(requested);
    return known
      ? { id: requested, kind: 'routing_profile', profileId: requested }
      : { id: requested, kind: 'unregistered', profileId: null };
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
 * How much reasoning the caller asked for, or null for the default.
 *
 * `'extended'` is the only value producible today and the column is `text` so a
 * graded scale needs no migration. Two inputs, because a caller can express the
 * same intent either way and recording only one of them undercounts:
 *
 *  - `thinkingMode: true` on the request body, which is the parameter;
 *  - `alia-v1-thinking`, which is the same parameter wearing a model's name.
 */
export type ReasoningEffort = 'extended';

export function reasoningEffortOf(input: {
  readonly thinkingMode?: boolean;
  readonly requestedModel: string;
}): ReasoningEffort | null {
  if (input.thinkingMode === true) return 'extended';
  return input.requestedModel === THINKING_ALIAS ? 'extended' : null;
}

/**
 * The one alias whose identity IS a reasoning setting.
 *
 * Asserted against `ROUTING_PRESETS` in `__tests__/requested-model.test.ts`
 * rather than trusted: it shares a preset with `alia-v1-pro-max`, and if that
 * ever stops being true this constant is naming a model instead of a setting.
 */
const THINKING_ALIAS = 'alia-v1-thinking';
