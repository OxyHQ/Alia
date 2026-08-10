/**
 * Inbound webhook events: the dedupe claim, and the audit of what became of each.
 *
 * ## The claim is an INSERT whose RESULT is the answer
 *
 * Mongo inserted the row and read a duplicate-key error as "somebody else has
 * this event". That shape does not port: in Postgres a failed statement aborts
 * the whole transaction (`25P02`), and — worse for a claim — catching an error to
 * mean "duplicate" cannot tell a duplicate from a dropped connection or an
 * exhausted pool. Answering "already processed" to either would retire a decision
 * nobody ever handled.
 *
 * `INSERT … ON CONFLICT (id) DO NOTHING … RETURNING` has no such ambiguity: no
 * statement fails, the EMPTY result set is the answer, and a genuine failure
 * still propagates as an exception. That is the same reasoning
 * `reportRepository.ts` applies from the other side, where a recovery read DOES
 * need the row and therefore needs a savepoint.
 *
 * ## The claim is deliberately OUTSIDE the inbound transaction
 *
 * `@oxyhq/crowdsource-express` claims before running the handler, and
 * `inbound-service.ts` opens its own transaction inside that handler. Do not tidy
 * the claim inward: claiming BEFORE the handler runs is what stops a concurrent
 * redelivery running it at the same time, and releasing on a throw is what keeps
 * §10.9's retry schedule able to deliver it later. Folding the claim into the
 * transaction would make a rollback release the claim and the work together,
 * which sounds tidier and reintroduces the double-run.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../index';
import { moderationEvents } from '../schema/moderation';

/**
 * Long enough to answer "was this event ever delivered" about a case open for
 * months, and bounded so the table cannot grow forever. The row's only content is
 * its own id and what became of it, so deleting an expired one is exactly the
 * intent — unlike the outbox, this table never holds unprocessed WORK.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Take the claim, or report that somebody else has it.
 *
 * `true` means this call inserted the row. `false` means a row already existed —
 * NOT that anything failed.
 */
export async function claimModerationEvent(eventId: string): Promise<boolean> {
  const rows = await getDb()
    .insert(moderationEvents)
    .values({
      id: eventId,
      state: 'claimed',
      receivedAt: sql`now()`,
      expiresAt: sql`now() + make_interval(secs => ${MODERATION_EVENT_RETENTION_SECONDS}::double precision)`,
    })
    .onConflictDoNothing({ target: moderationEvents.id })
    .returning({ id: moderationEvents.id });
  return rows.length === 1;
}

/** Give the claim back so a redelivery can be processed. */
export async function releaseModerationEvent(eventId: string): Promise<void> {
  await getDb().delete(moderationEvents).where(eq(moderationEvents.id, eventId));
}

/**
 * Record a decision-bearing event as queued, with the CALLER's transaction.
 *
 * Takes an `Executor` because it commits together with the `decision.apply`
 * outbox row: if completing this row and queueing the work were two operations, a
 * crash between them would leave an event permanently deduplicated with no work
 * queued — a decision silently lost, with a row saying it arrived.
 *
 * An UPDATE rather than an upsert, because the claim already created the row.
 */
export async function markModerationEventQueued(
  executor: Executor,
  input: { eventId: string; type: string; caseId: string; decision: unknown },
): Promise<void> {
  await executor
    .update(moderationEvents)
    .set({
      type: input.type,
      caseId: input.caseId,
      payload: { caseId: input.caseId, decision: input.decision },
      state: 'queued',
      queuedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(moderationEvents.id, input.eventId));
}

/**
 * Record an event there is nothing to do about.
 *
 * `case.created`, `case.escalated`, `case.closed` and any type a newer
 * CrowdSource introduces. No outbox row, because no work — but the row is kept,
 * because "did CrowdSource tell us about this case, and when" is the first
 * question asked when a report looks stuck, and it has to be answerable.
 *
 * No transaction: there is no second write to commit with.
 */
export async function markModerationEventIgnored(input: {
  eventId: string;
  type: string;
  caseId?: string;
}): Promise<void> {
  await getDb()
    .update(moderationEvents)
    .set({
      type: input.type,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      state: 'ignored',
      updatedAt: sql`now()`,
    })
    .where(eq(moderationEvents.id, input.eventId));
}
