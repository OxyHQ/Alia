import { createAgentReviewSubjectProvider } from './agent-review-subject.js';
import { createAgentSubjectProvider } from './agent-subject.js';
import { createSkillSubjectProvider } from './skill-subject.js';
import type { ModerationSubjectProvider } from './types.js';

/**
 * Every noun Alia can send for community review, and the §5.4 type each one is.
 *
 * Adding a subject type is one entry here plus one provider file. Nothing else in
 * the integration knows what an agent is — not the outbox, not the delivery
 * worker, not the webhook receiver, not the enforcement service.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A reported type
 * WITHOUT one is still accepted by `POST /reports` and still stored — it simply
 * never leaves. The registry is not an admission gate on the API, because a gate
 * that refuses unwired types means an application breaks its own report surfaces
 * on the day it adopts CrowdSource. Incremental adoption, one subject type at a
 * time, is the property that makes this integration copyable at all.
 *
 * ## Alia reports what somebody PUBLISHED, and nothing a model generated
 *
 * This is the argument that shapes the whole file, so it is written down here
 * rather than inferred from three provider files and a gap.
 *
 * Alia is an AI platform, so the obvious question is whether a case can be about a
 * model's output. It cannot, and not because generated text is beneath review —
 * because every honest way of filing one fails:
 *
 * **There is no audience, so there is no reporter.** Conversations, messages and
 * generated shows are scoped to their owner on every route. `Conversation` carries
 * an `isPublic` flag that nothing in this repository reads, and the app's "Share
 * conversation" menu item is a "coming soon" toast. Nobody but the author can ever
 * see a generated turn, so the only possible reporter is the person who prompted
 * it — and that is product feedback, which Alia already collects as
 * `IMessage.vote`. A jury of strangers is the wrong instrument for it.
 *
 * **Neither available subject author is honest.** `ReportSubjectInput.author` has
 * to name somebody. Naming the USER means an `oxy_user` binding, and a binding
 * proof is exactly what makes an Oxy Trust reputation effect possible — a person
 * would carry a consequence for text a model wrote. Naming a `bot` principal
 * avoids that but leaves a case whose only possible consequence is inside Alia,
 * against a message one person can see.
 *
 * **The evidence is the prompt.** A generated turn cannot be judged without what
 * was asked for — a refusal-bypass and an ordinary answer are indistinguishable
 * otherwise. So an honest report necessarily carries the user's own words as
 * context. §8.7 asks us to pseudonymise what is not needed; here the private half
 * IS what is needed, and no pseudonymisation reaches it.
 *
 * What Alia can honestly hand a jury is the work a person chose to PUBLISH: an
 * agent listing, a review, a community skill. Each has an audience that can report
 * it, an author who is answerable for it, and a stable row §5.6 can pin.
 *
 * ## Why an account has no provider
 *
 * `ReportedType.USER` is accepted and never delivered. Oxy owns identity — Alia
 * stores a denormalized `authorName` beside the objects a person publishes and
 * nothing else, so there is no Alia-side profile to snapshot and no version of one
 * to pin. Reporting an account under Alia's credential would also open the case in
 * ALIA's tenant naming an actor only Oxy can act against, and a second Oxy product
 * reporting the same account gets a different §7.3 dedup key — one person, two
 * cases, two juries. That is a cross-application design question the plan has not
 * answered, so the report stays local until it does.
 */
const PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  createAgentSubjectProvider(),
  createAgentReviewSubjectProvider(),
  createSkillSubjectProvider(),
]);

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  PROVIDERS.map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment. Intake asks
 * before queueing a delivery and the snapshot builder asks again when it builds
 * one; a type this returns `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can pin the set. That is not ceremony: the difference between a
 * delivered type and a local-only one is invisible in a 201, so registering a
 * provider — or forgetting to — is a change no response body would reveal. The
 * assertion makes widening the delivered surface a deliberate act with an argument
 * attached.
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}
