/**
 * The log of events Oxy services have pushed, on Postgres.
 *
 * `UNIQUE(service_id, oxy_user_id, event_id)` is the idempotency key: it is what
 * makes a service's retry converge on the existing row instead of running an
 * autonomous action a second time.
 *
 * ## The claim is `ON CONFLICT DO NOTHING RETURNING`, and that is not a stylistic
 * choice
 *
 * The source inserted, let the duplicate-key error escape, and recovered inside
 * a `catch` by updating the row it had just collided with. That shape does not
 * port: in Postgres a failed statement aborts the whole transaction (`25P02`),
 * so the recovery update would itself fail with "current transaction is aborted"
 * the moment this route ever ran inside one. It does not today — there is no
 * transaction on this path — which is exactly what makes it a trap rather than a
 * bug, because nothing here would go red when a later change introduced one.
 *
 * `ON CONFLICT DO NOTHING … RETURNING id` has no failing statement at all, and
 * the empty-versus-one-row result IS the answer. A real failure — a CHECK
 * violation, a lost connection — still propagates, because `DO NOTHING` narrows
 * only the unique-violation case. The route reads `null` as "already seen".
 *
 * ## Marking a redelivery overwrites a `processed` status, deliberately
 *
 * `markOxyServiceEventDuplicate` sets `status = 'duplicate'` on whatever the row
 * held, including `processed`. That is what Mongo did, and this is a port; the
 * row's purpose is to record that Alia refused to act twice, and the timestamps
 * beside it preserve when it first ran. Changing it would need a reason of its
 * own.
 */

import { and, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  oxyServiceEventLogs,
  type OxyServiceEventAction,
} from '../schema/oxy-services';

export interface NewOxyServiceEvent {
  readonly serviceId: string;
  readonly oxyUserId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly action: OxyServiceEventAction;
  readonly payloadHash: string;
}

/**
 * Claim an inbound event, or answer `null` when it has already been claimed.
 *
 * The returned id is what the async processor updates; the route needs it before
 * it answers `202`, which is why `generatedId()` produces it application-side.
 */
export async function claimOxyServiceEvent(
  db: ApiDatabase,
  input: NewOxyServiceEvent,
): Promise<string | null> {
  const [row] = await db
    .insert(oxyServiceEventLogs)
    .values({
      serviceId: input.serviceId,
      oxyUserId: input.oxyUserId,
      eventId: input.eventId,
      eventName: input.eventName,
      action: input.action,
      status: 'received',
      payloadHash: input.payloadHash,
    })
    .onConflictDoNothing({
      target: [
        oxyServiceEventLogs.serviceId,
        oxyServiceEventLogs.oxyUserId,
        oxyServiceEventLogs.eventId,
      ],
    })
    .returning({ id: oxyServiceEventLogs.id });

  return row?.id ?? null;
}

/** Record that a redelivery arrived, on the row it collided with. */
export async function markOxyServiceEventDuplicate(
  db: ApiDatabase,
  key: { serviceId: string; oxyUserId: string; eventId: string },
): Promise<void> {
  await db
    .update(oxyServiceEventLogs)
    .set({ status: 'duplicate', processedAt: new Date() })
    .where(
      and(
        eq(oxyServiceEventLogs.serviceId, key.serviceId),
        eq(oxyServiceEventLogs.oxyUserId, key.oxyUserId),
        eq(oxyServiceEventLogs.eventId, key.eventId),
      ),
    );
}

/**
 * Record that an event was handled.
 *
 * `processedAt` is set unconditionally beside `status`, which is what satisfies
 * `oxy_service_event_logs_processed_pair_check` — Mongo left the two free to
 * disagree and every writer happened to set them together; here the database
 * refuses the state, so the pairing is structural rather than a habit.
 */
export async function markOxyServiceEventProcessed(
  db: ApiDatabase,
  logId: string,
  agentSessionId?: string,
): Promise<void> {
  await db
    .update(oxyServiceEventLogs)
    .set({
      status: 'processed',
      processedAt: new Date(),
      ...(agentSessionId === undefined ? {} : { agentSessionId }),
    })
    .where(eq(oxyServiceEventLogs.id, logId));
}

/**
 * Record that an event could not be handled, and why.
 *
 * `agentSessionId` is spread in rather than passed as `null`, because the source
 * only ever SET it — `$set` with an absent key leaves the stored value alone in
 * Mongo, while `.set({ agentSessionId: undefined })` in drizzle would be a no-op
 * and `.set({ agentSessionId: null })` would ERASE a session id an earlier write
 * had recorded. The two spellings look alike and one of them loses the link
 * between a failure and the session it failed in.
 */
export async function markOxyServiceEventFailed(
  db: ApiDatabase,
  logId: string,
  errorMessage: string,
  agentSessionId?: string,
): Promise<void> {
  await db
    .update(oxyServiceEventLogs)
    .set({
      status: 'failed',
      processedAt: new Date(),
      errorMessage,
      ...(agentSessionId === undefined ? {} : { agentSessionId }),
    })
    .where(eq(oxyServiceEventLogs.id, logId));
}
