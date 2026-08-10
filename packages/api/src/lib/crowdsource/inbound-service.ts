import { getDb } from '../../db/index.js';
import {
  markModerationEventIgnored,
  markModerationEventQueued,
} from '../../db/moderation/moderationEventRepository.js';
import {
  decisionApplyEventId,
  enqueueModerationOutboxEvent,
} from '../../db/moderation/outboxRepository.js';

/**
 * What happens between "a signed decision arrived" and "2xx".
 *
 * §10.8: answer quickly and queue the processing. So exactly two writes happen
 * here, in ONE transaction — the event's audit row is completed and a durable
 * `decision.apply` event is created — and the dispatcher does the rest.
 *
 * The transaction is what makes the dedupe safe. The middleware has already
 * claimed the event id by inserting the row (see `event-store.ts`); if completing
 * that row and queueing the work were two operations, a crash between them would
 * leave an event that is permanently deduplicated with no work queued — a decision
 * silently lost, with a row that says it arrived. Committing both together means
 * the only two possible outcomes are "recorded and queued" or "neither", and
 * "neither" releases the claim and gets redelivered.
 *
 * Both writes take the SAME `tx`. That is the whole mechanism, and it is the one
 * thing a reviewer should check here: handing either of them the root handle
 * compiles, and `enqueueModerationOutboxEvent` refuses it at runtime precisely
 * because the type cannot.
 */

export interface RecordDecisionEventInput {
  eventId: string;
  type: string;
  caseId: string;
  /**
   * The decision as delivered.
   *
   * `unknown`, deliberately. It is stored whole and parsed against the published
   * contract by the worker that acts on it — §10.11 makes these payloads loose,
   * and validating here would mean an event whose shape this deployment does not
   * recognise yet is refused at the door and retried until it dead-letters,
   * instead of being kept until the code catches up.
   */
  decision: unknown;
}

/** Record a decision-bearing event and queue its application. */
export async function recordDecisionEvent(
  input: RecordDecisionEventInput,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await markModerationEventQueued(tx, input);
    await enqueueModerationOutboxEvent(tx, {
      eventId: decisionApplyEventId(input.eventId),
      kind: 'decision.apply',
      payload: {
        eventId: input.eventId,
        caseId: input.caseId,
        decision: input.decision,
      },
    });
  });
}

/**
 * Record an event there is nothing to do about.
 *
 * `case.created`, `case.escalated`, `case.closed` and any type a newer CrowdSource
 * introduces. No outbox row, because no work — but the row is kept, because "did
 * CrowdSource tell us about this case, and when" is the first question asked when
 * a report looks stuck, and it has to be answerable.
 *
 * No transaction, because there is no second write to commit with. That asymmetry
 * with `recordDecisionEvent` is the point rather than an inconsistency.
 */
export async function recordIgnoredEvent(input: {
  eventId: string;
  type: string;
  caseId?: string;
}): Promise<void> {
  await markModerationEventIgnored(input);
}
