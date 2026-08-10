/**
 * The moderation outbox, on Postgres. The ROW is the job.
 *
 * This file is the weld in the moderation slice. Two transactions live in this
 * service and BOTH write this table through {@link enqueueModerationOutboxEvent}
 * — intake (`reports` + this) and inbound (`moderation_events` + this) — which is
 * why those three tables had to switch stores in one commit. A Mongo
 * `ClientSession` cannot enlist a Postgres write, so leaving either transaction
 * behind would have produced a queue that looks empty rather than an error.
 *
 * ## The enqueue takes an EXECUTOR, and refuses the root connection
 *
 * Mongo's spelling was a required `ClientSession` plus `session.inTransaction()`,
 * because a required parameter is satisfied by a bare `startSession()` nobody
 * opened a transaction on — code that type-checks perfectly and commits the row
 * on its own. Postgres has exactly the same hole one level over: `Executor` is a
 * union, and passing the root `db` where a `tx` belongs compiles.
 *
 * {@link requireTransaction} closes it the same way, discriminating on `rollback`
 * — MEASURED on this drizzle/postgres.js: the root handle has no `rollback`, a
 * transaction handle has one, and both execute statements, so "absent" is a
 * property of the root rather than of a dead handle. The consequence of the hole
 * is why it is guarded rather than reviewed: a report answered 201 whose delivery
 * event committed separately is lost moderation work with no trace.
 *
 * ## The clock is the SERVER's
 *
 * Every instant compared or stored here is Postgres's `now()`; nothing binds a
 * JavaScript `Date`. Mongo compared against the caller's clock, which was already
 * wrong and merely invisible — several ECS tasks share this queue, and two whose
 * clocks disagree by more than a lease would both believe a lease had expired and
 * both claim the same event. `db/coordination/leaseRepository.ts` reaches the
 * same conclusion for the same reason. Durations stay parameters: a duration has
 * no clock to disagree about.
 */

import { and, eq, gt, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../index';
import { moderationOutboxes, MODERATION_OUTBOX_KINDS } from '../schema/moderation';

export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];

/**
 * Retention ceiling, so a stalled dispatcher cannot make this table unbounded.
 *
 * Long, because a moderation case can legitimately sit open for weeks and a
 * `dead_letter` row is evidence somebody still has to look at. Operational alerts
 * must fire long before this deadline. Owned here rather than by a model, because
 * the repository owns the table's shape now.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export interface ModerationOutboxPayload {
  /** The local report id, for `report.submit`. */
  reportId?: string;
  /** The inbound webhook event id, for `decision.apply` (Appendix D). */
  eventId?: string;
  /** The CrowdSource case a decision belongs to. */
  caseId?: string;
  /**
   * The decision exactly as CrowdSource published it.
   *
   * Stored whole and opaque rather than projected into columns: §10.11 makes the
   * decision document loose, and a projection would silently drop whatever a
   * newer CrowdSource added — including a finding the enforcement mapping may
   * later need. It is validated against the published contract when it is READ,
   * so an event is never lost to a schema this deployment has not caught up with.
   */
  decision?: unknown;
}

/** The claimed job, as the dispatcher and its workers read it. */
export interface ModerationOutboxEvent {
  id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Raised when an outbox event is written outside a transaction.
 *
 * Never expected at runtime. It exists so the invariant is ENFORCED rather than
 * reviewed — see {@link enqueueModerationOutboxEvent}.
 */
export class ModerationOutboxTransactionError extends Error {
  constructor(eventId: string) {
    super(
      `Refusing to enqueue moderation outbox event '${eventId}' outside a transaction: ` +
        'the domain write and this row must commit together, or a report is answered 201 ' +
        'and never delivered.',
    );
    this.name = 'ModerationOutboxTransactionError';
  }
}

/**
 * The executor, narrowed to one that is actually IN a transaction.
 *
 * `Executor` is `ApiDatabase | <transaction handle>`, and TypeScript cannot tell
 * which one a caller passed — so this is the runtime half of a claim the type
 * system makes only half of. It discriminates on `rollback` rather than on a
 * brand or an `instanceof`: drizzle gives the transaction handle a `rollback`
 * method and the root connection none, which is a structural fact about the
 * handle rather than a convention this file invented.
 */
function requireTransaction(executor: Executor, eventId: string): Executor {
  const rollback: unknown = (executor as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') throw new ModerationOutboxTransactionError(eventId);
  return executor;
}

/**
 * The event id for delivering a report.
 *
 * Derived from the report, not from the request: a transaction retry or two
 * concurrent duplicate submissions upsert the SAME event rather than queueing two
 * deliveries. There is exactly one delivery event per report for the life of the
 * report, which is also what makes the CrowdSource-side idempotency key stable.
 */
export function reportSubmitEventId(reportId: string): string {
  return `moderation:report.submit:${reportId}`;
}

/**
 * The event id for applying an inbound decision (Appendix D).
 *
 * The webhook event id is the key, so a redelivery of the same event can never
 * queue the work twice even if the dedupe claim were somehow released.
 */
export function decisionApplyEventId(eventId: string): string {
  return `moderation:decision.apply:${eventId}`;
}

/** `now() + n seconds`, with the cast `make_interval`'s named argument needs. */
function secondsFromNow(seconds: number) {
  return sql`now() + make_interval(secs => ${seconds}::double precision)`;
}

/**
 * Write the event with the CALLER's transaction.
 *
 * The whole point of the table: the domain write and this row commit together or
 * not at all. There is deliberately no overload that enqueues outside one — that
 * would be the single line quietly reintroducing "the report was answered 201 and
 * then vanished".
 *
 * `ON CONFLICT DO NOTHING`, never `DO UPDATE`. A repeat must write no tuple
 * version and touch no timestamp, because the dispatcher may be holding a lease
 * on this very row when it arrives. Mongo needed `$setOnInsert` PLUS
 * `timestamps: false` to get the same no-op — Mongoose otherwise added its own
 * `$set: { updatedAt }` and modified a row the operator promised to leave alone.
 * Here it is one clause.
 *
 * This is also the ONLY writer that CREATES a row in this table; the dispatcher
 * claims existing rows and never inserts one. So there is no second queue that
 * can drift out of sync — a job is never the only evidence that work exists,
 * because the row IS the job.
 */
export async function enqueueModerationOutboxEvent(
  executor: Executor,
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
): Promise<string> {
  const tx = requireTransaction(executor, input.eventId);
  await tx
    .insert(moderationOutboxes)
    .values({
      id: input.eventId,
      kind: input.kind,
      payload: input.payload,
      availableAt: sql`now()`,
      expiresAt: secondsFromNow(MODERATION_OUTBOX_RETENTION_SECONDS),
    })
    .onConflictDoNothing();
  return input.eventId;
}

/** Due work: pending and its time has come, or processing with a dead lease. */
function claimable() {
  return or(
    and(
      eq(moderationOutboxes.status, 'pending'),
      lte(moderationOutboxes.availableAt, sql`now()`),
    ),
    and(
      eq(moderationOutboxes.status, 'processing'),
      isNotNull(moderationOutboxes.leaseUntil),
      lte(moderationOutboxes.leaseUntil, sql`now()`),
    ),
  );
}

/**
 * Atomically claim one due event, oldest first.
 *
 * Mongo did this with `findOneAndUpdate` + `sort`, which is atomic per document.
 * The Postgres equivalent is an `UPDATE` whose target is chosen by a subquery
 * taking `FOR UPDATE SKIP LOCKED` — and SKIP LOCKED is the load-bearing half.
 * Without it, N dispatcher tasks all pick the same oldest row and serialise
 * behind one lock; with it, each takes a different row and the queue actually
 * parallelises. It is also why an expired `processing` lease is reclaimable with
 * no sweeper: a dead worker's row simply becomes due again.
 *
 * **Not expressible against a mock.** A mocked `update` accepts any statement,
 * including one whose lock clause does nothing at all.
 */
export async function claimModerationOutboxEvent(options: {
  leaseOwner: string;
  eventId?: string;
  leaseMs?: number;
}): Promise<ModerationOutboxEvent | null> {
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const due = options.eventId
    ? and(eq(moderationOutboxes.id, options.eventId), claimable())
    : claimable();

  const oldestDue = sql`(
    select ${moderationOutboxes.id} from ${moderationOutboxes}
    where ${due}
    order by ${moderationOutboxes.createdAt} asc
    limit 1
    for update skip locked
  )`;

  const [claimed] = await getDb()
    .update(moderationOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: secondsFromNow(leaseMs / 1_000),
      attempts: sql`${moderationOutboxes.attempts} + 1`,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(moderationOutboxes.id, oldestDue))
    .returning({
      id: moderationOutboxes.id,
      kind: moderationOutboxes.kind,
      payload: moderationOutboxes.payload,
      attempts: moderationOutboxes.attempts,
      availableAt: moderationOutboxes.availableAt,
      leaseOwner: moderationOutboxes.leaseOwner,
      leaseUntil: moderationOutboxes.leaseUntil,
      expiresAt: moderationOutboxes.expiresAt,
      createdAt: moderationOutboxes.createdAt,
    });

  if (!claimed) return null;
  // `payload` is `jsonb`, so drizzle types it `unknown` — the shape belongs to
  // the CrowdSource contract and is read defensively by the workers.
  return { ...claimed, payload: claimed.payload as ModerationOutboxPayload };
}

/** Only the lease this dispatcher currently owns, and only while it is live. */
function ownedLiveLease(eventId: string, leaseOwner: string) {
  return and(
    eq(moderationOutboxes.id, eventId),
    eq(moderationOutboxes.status, 'processing'),
    eq(moderationOutboxes.leaseOwner, leaseOwner),
    gt(moderationOutboxes.leaseUntil, sql`now()`),
  );
}

/**
 * Complete only the lease this dispatcher currently owns.
 *
 * The boolean comes off `RETURNING`, which is the one reading that is right under
 * both of Mongo's two counts. Mongo reported `matchedCount` AND `modifiedCount`
 * and this call site read `modifiedCount`; Postgres reports only a row count,
 * which behaves like `matchedCount`. They agree HERE because the update always
 * changes `status`, so a matched row is always a modified one — stated because
 * the same substitution is not safe everywhere and the next reader should not
 * have to re-derive it. (`rows.length` off a plain `UPDATE` is 0 either way; it
 * means something only because of the `RETURNING`.)
 */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(moderationOutboxes)
    .set({
      status: 'processed',
      processedAt: sql`now()`,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(ownedLiveLease(eventId, leaseOwner))
    .returning({ id: moderationOutboxes.id });
  return rows.length === 1;
}

/**
 * Extend only a live lease still owned by this dispatcher.
 *
 * Mongo read `matchedCount` here, NOT `modifiedCount`, and deliberately: renewing
 * twice within one instant writes an identical `leaseUntil`, which Mongo counts
 * as matched-but-not-modified. Reading the wrong count would report a still-held
 * lease as lost and abandon work mid-delivery. Postgres's row count IS
 * `matchedCount`, so this one is a faithful port rather than a coincidence.
 */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await getDb()
    .update(moderationOutboxes)
    .set({
      leaseUntil: secondsFromNow(Math.max(1_000, leaseMs) / 1_000),
      updatedAt: sql`now()`,
    })
    .where(ownedLiveLease(eventId, leaseOwner))
    .returning({ id: moderationOutboxes.id });
  return rows.length === 1;
}

export interface ModerationOutboxFailure {
  released: boolean;
  deadLettered: boolean;
}

/**
 * Release a failed claim with backoff — or stop.
 *
 * Stopping is not an optimisation. A 409 means this `externalReportId` already
 * exists at CrowdSource with a different body, and no number of retries turns two
 * payloads into one report; a 422 means the envelope is not processable. Both
 * need the payload to change, so they become `dead_letter` immediately and stay
 * visible with their error rather than accumulating attempts nobody reads.
 *
 * Whether this failure is terminal is the CALLER's decision — `outbox.ts` owns
 * the retryability rule and the attempt ceiling. This function owns the row.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, 'id' | 'attempts'>,
  leaseOwner: string,
  message: string,
  deadLettered: boolean,
): Promise<ModerationOutboxFailure> {
  const backoffSeconds = Math.min(
    2 ** Math.max(0, Math.min(event.attempts - 1, 20)),
    6 * 60 * 60,
  );
  const rows = await getDb()
    .update(moderationOutboxes)
    .set({
      status: deadLettered ? 'dead_letter' : 'pending',
      availableAt: deadLettered ? sql`now()` : secondsFromNow(backoffSeconds),
      lastError: message.slice(0, 2_000),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(ownedLiveLease(event.id, leaseOwner))
    .returning({ id: moderationOutboxes.id });
  return { released: rows.length === 1, deadLettered };
}
