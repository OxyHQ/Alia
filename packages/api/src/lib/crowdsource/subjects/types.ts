/**
 * The seam that makes this integration copyable.
 *
 * CrowdSource's side of the "don't design moderation around your own nouns"
 * problem is already solved — the Case Envelope knows nothing about an agent, a
 * post or a listing, and `@oxyhq/crowdsource` composes one from a description of
 * the material. What is left for an application is a translation problem, and this
 * file is the whole of it:
 *
 *     "given one of MY nouns and its id, describe the material"
 *
 * Everything downstream — resource ids, relations, digests, pseudonymous principal
 * refs, the identity binding proof, the pinned policy version, privacy terms, the
 * idempotency key, the envelope itself — is composed by the SDK from that
 * description and is IDENTICAL for every application and every subject type. So
 * adding a subject type is one file implementing {@link ModerationSubjectProvider}
 * plus one line in the registry; nothing in the outbox, the delivery worker, the
 * webhook receiver, the decision worker or the enforcement service changes.
 *
 * Two rules keep it that way, and both are load-bearing rather than stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The types below are
 *    the SDK's own input types, re-exported unchanged. A provider that built an
 *    envelope would have to invent resource ids and principal refs, and §7.3's
 *    dedup key is computed over exactly those — two reporters describing one agent
 *    would open two cases, and "one penalty per incident" would fail in production
 *    with nothing failing in a test.
 * 2. **A provider is pure translation with reads.** It fetches its own object and
 *    returns; it does not decide whether to deliver, what the allegation is, or
 *    what happens to the report. Those belong to callers that are shared.
 */

import type { ContextInput, ReportSubjectInput, ResourceInput } from '@oxyhq/crowdsource';

/**
 * The SDK's resource description, unchanged.
 *
 * Re-exported as a type alias so a provider imports the vocabulary from this seam
 * rather than from four places — but it IS the SDK's type, not a local restatement
 * of it. A resource type added to the contract becomes available to every provider
 * the moment the dependency is bumped.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/**
 * One reported object, described.
 *
 * `content` is required because a report with no material is a question a jury
 * cannot answer. An application that cannot produce the material for one of its
 * nouns should not register a provider for it — see the registry.
 */
export interface ModerationSubjectSnapshot {
  /** Identity, type and author of the reported object (§5.1 `subject`). */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly — the agent a review is
   * about, the instructions a listing runs on. Context, not extra exposure: §9.1
   * keeps a reviewer's view to the minimum that makes the question answerable.
   */
  readonly context?: readonly ModerationContextResource[];
}

/**
 * Translates one of Alia's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun (§5.4): every Alia agent is a
 * `custom.alia.agent`, every agent review a `commerce.review`. Keeping it here
 * means the registry can answer "what does this application report?" without
 * loading a single object.
 */
export interface ModerationSubjectProvider {
  /** Alia's own name for the noun, as it arrives on a report. */
  readonly reportedType: string;
  /** §5.4's namespaced subject type, or `custom.<organization>.<object_type>`. */
  readonly subjectType: string;
  /**
   * Describes the object, or returns `null` when it no longer exists.
   *
   * `null` is not a failure. Content deleted between the report and its delivery
   * is ordinary, and it is the caller's job to decide what that means — a provider
   * that threw would make deletion look like an outage and be retried for days.
   */
  snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null>;
}
