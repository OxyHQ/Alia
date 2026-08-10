import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { setUpTestDatabase, type TestDatabaseHandle } from '../testDatabase';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  enqueueModerationOutboxEvent,
  failModerationOutboxEvent,
  ModerationOutboxTransactionError,
  renewModerationOutboxEvent,
} from '../moderation/outboxRepository';
import { moderationOutboxes } from '../schema/moderation';

/**
 * The moderation outbox against a REAL Postgres.
 *
 * Two properties here are the reason this file is `.pgdb` and not a mocked unit
 * test, and neither is expressible against a mock:
 *
 *  - **the co-commit**, below, whose discriminating case needs a real ROLLBACK;
 *  - **`FOR UPDATE SKIP LOCKED`**, which a mocked `update` would accept while
 *    doing nothing, so two concurrent claimers would look correct and take the
 *    same row in production.
 */

let db: ApiDatabase;
let database: TestDatabaseHandle;

/**
 * A PRIVATE database for this file.
 *
 * The suite's global setup makes ONE database for the whole run and vitest runs
 * FILES IN PARALLEL, so the moderation files would otherwise share `reports`
 * and `moderation_outboxes` — and each one's `afterEach` would wipe the others'
 * fixtures mid-test. Measured: that is exactly what happened, and it surfaced as
 * "unique violation but no existing row found", which names nothing about the
 * cause.
 *
 * Namespacing the fixtures would fix the COLLISION but not the ASSERTIONS. The
 * co-commit test's entire claim is "the table holds NO row" and "exactly ONE
 * row"; scoping those counts to a prefix is one subtle predicate away from an
 * assertion that cannot fail — and that assertion is what the whole slice rests
 * on. An own database keeps a global count meaning what it says.
 */
beforeAll(async () => {
  database = await setUpTestDatabase();
  const connected = connectPostgres(database.databaseUrl);
  if (!connected) throw new Error('could not connect to this file\'s throwaway database');
  db = connected;
}, 120_000);

afterEach(async () => {
  await db.execute(sql`truncate ${moderationOutboxes}`);
});

afterAll(async () => {
  await closePostgres();
  await database.drop();
});

const EVENT = {
  eventId: 'moderation:report.submit:r1',
  kind: 'report.submit',
  payload: { reportId: 'r1' },
} as const;

const rows = () => db.select().from(moderationOutboxes);

/**
 * THE test in this slice.
 *
 * `enqueueModerationOutboxEvent` is written by BOTH of this service's
 * transactions — intake and inbound — through a third file that neither of them
 * lives in. If it ever ran on its own connection instead of the caller's, both
 * transactions would silently stop being atomic at once, and the symptom would
 * be a report answered 201 whose delivery event committed alone.
 *
 * The obvious test does NOT catch that. "Make the outbox write fail and check
 * the report rolled back" passes whether or not the append was enlisted, because
 * the throw propagates either way. What discriminates is the opposite order: the
 * enqueue SUCCEEDS, a later statement in the same transaction throws, and the row
 * survives if and only if it escaped.
 */
describe('the enqueue is enlisted in the CALLER transaction', () => {
  it('leaves NO row when a later statement in the same transaction throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueModerationOutboxEvent(tx, EVENT);
        // The row exists inside the transaction at this point — an escape would
        // have committed it already, and a correct enlistment has it pending.
        throw new Error('the domain write failed after the enqueue');
      }),
    ).rejects.toThrow('the domain write failed after the enqueue');

    expect(await rows()).toHaveLength(0);
  });

  /**
   * The positive control, in the SAME currency as the measurement: same table,
   * same helper, same assertion instrument, same transaction shape — only the
   * throw removed. Without it, "0 rows" is equally what a fixture that never
   * wrote anything would report.
   */
  it('leaves EXACTLY ONE row when the same transaction commits', async () => {
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(tx, EVENT);
    });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('pending');
  });

  /**
   * The type cannot tell `ApiDatabase` from a transaction handle once both are
   * widened to `Executor`, so passing the root connection where a `tx` belongs
   * COMPILES. This is Mongo's `session.inTransaction()` check, ported: there the
   * hole was a bare `startSession()` nobody opened a transaction on.
   */
  it('refuses the root connection, and writes nothing when it refuses', async () => {
    await expect(enqueueModerationOutboxEvent(db, EVENT)).rejects.toBeInstanceOf(
      ModerationOutboxTransactionError,
    );
    // A refusal that still wrote the row would be worse than no check at all.
    expect(await rows()).toHaveLength(0);
  });

  it('says why, in terms of the consequence rather than the rule', async () => {
    await expect(enqueueModerationOutboxEvent(db, EVENT)).rejects.toThrow(
      /answered 201 and never delivered/,
    );
  });

  it('sets its own deadline, far enough out that no sweep can reach it', async () => {
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(tx, EVENT);
    });
    const [stored] = await rows();
    // 90 days. The row is expiry-swept on `expires_at` with retention ZERO, so a
    // deadline in the past would make the fixture reapable by a sibling file.
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 80 * 24 * 3_600_000);
  });
});

describe('claiming', () => {
  const enqueue = (eventId: string) =>
    db.transaction(async (tx) =>
      enqueueModerationOutboxEvent(tx, { ...EVENT, eventId, payload: { reportId: eventId } }),
    );

  it('claims a due event and takes a lease on it', async () => {
    await enqueue('e1');

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'worker-a' });

    expect(claimed?.id).toBe('e1');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.kind).toBe('report.submit');
    expect(claimed?.payload.reportId).toBe('e1');
    const [stored] = await rows();
    expect(stored?.status).toBe('processing');
    expect(stored?.leaseOwner).toBe('worker-a');
  });

  it('answers null when there is nothing due', async () => {
    expect(await claimModerationOutboxEvent({ leaseOwner: 'worker-a' })).toBeNull();
  });

  it('does not claim an event whose time has not come', async () => {
    await enqueue('e1');
    await db
      .update(moderationOutboxes)
      .set({ availableAt: sql`now() + interval '1 hour'` })
      .where(eq(moderationOutboxes.id, 'e1'));

    expect(await claimModerationOutboxEvent({ leaseOwner: 'worker-a' })).toBeNull();
  });

  it('does not claim an event another worker holds a LIVE lease on', async () => {
    await enqueue('e1');
    await claimModerationOutboxEvent({ leaseOwner: 'worker-a', leaseMs: 60_000 });

    expect(await claimModerationOutboxEvent({ leaseOwner: 'worker-b' })).toBeNull();
  });

  /**
   * A dead worker must not strand moderation work forever, and this is what
   * replaces a sweeper: an expired `processing` lease is simply due again.
   */
  it('reclaims an EXPIRED lease, and counts the attempt', async () => {
    await enqueue('e1');
    await claimModerationOutboxEvent({ leaseOwner: 'worker-a' });
    await db
      .update(moderationOutboxes)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(moderationOutboxes.id, 'e1'));

    const reclaimed = await claimModerationOutboxEvent({ leaseOwner: 'worker-b' });

    expect(reclaimed?.id).toBe('e1');
    expect(reclaimed?.attempts).toBe(2);
  });

  it('takes the OLDEST due event first', async () => {
    await enqueue('older');
    await enqueue('newer');
    await db
      .update(moderationOutboxes)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(moderationOutboxes.id, 'older'));

    expect((await claimModerationOutboxEvent({ leaseOwner: 'w' }))?.id).toBe('older');
  });

  /**
   * Two claimers running at once must take DIFFERENT rows. Without
   * `SKIP LOCKED` the second blocks on the first's row lock and then finds it no
   * longer due — the queue still works, one row at a time, which is why this
   * cannot be caught by asserting correctness of a single claim.
   */
  it('gives two concurrent claimers two different events', async () => {
    await enqueue('e1');
    await enqueue('e2');

    const [a, b] = await Promise.all([
      claimModerationOutboxEvent({ leaseOwner: 'worker-a' }),
      claimModerationOutboxEvent({ leaseOwner: 'worker-b' }),
    ]);

    expect([a?.id, b?.id].sort()).toEqual(['e1', 'e2']);
  });

  it('claims a NAMED event when one is asked for', async () => {
    await enqueue('e1');
    await enqueue('e2');

    expect((await claimModerationOutboxEvent({ leaseOwner: 'w', eventId: 'e2' }))?.id).toBe('e2');
  });
});

describe('completing, renewing and failing a claim', () => {
  const enqueueAndClaim = async (leaseOwner: string, leaseMs?: number) => {
    await db.transaction(async (tx) => enqueueModerationOutboxEvent(tx, EVENT));
    return await claimModerationOutboxEvent({ leaseOwner, ...(leaseMs ? { leaseMs } : {}) });
  };

  it('completes the lease it owns', async () => {
    await enqueueAndClaim('worker-a');

    expect(await completeModerationOutboxEvent(EVENT.eventId, 'worker-a')).toBe(true);
    const [stored] = await rows();
    expect(stored?.status).toBe('processed');
    expect(stored?.processedAt).toBeInstanceOf(Date);
    expect(stored?.leaseOwner).toBeNull();
  });

  it('refuses to complete a lease owned by somebody else', async () => {
    await enqueueAndClaim('worker-a');

    expect(await completeModerationOutboxEvent(EVENT.eventId, 'worker-b')).toBe(false);
    expect((await rows())[0]?.status).toBe('processing');
  });

  /**
   * Renewing twice in quick succession can write an identical `lease_until`.
   * Mongo counted that as matched-but-not-modified, which is why this call site
   * read `matchedCount` and not `modifiedCount` — reading the wrong one reports a
   * still-held lease as LOST and abandons work mid-delivery. Postgres's row count
   * is `matchedCount`, and this asserts the port kept that reading.
   */
  it('reports a renewal as successful even when nothing changed', async () => {
    await enqueueAndClaim('worker-a', 60_000);

    expect(await renewModerationOutboxEvent(EVENT.eventId, 'worker-a', 60_000)).toBe(true);
    expect(await renewModerationOutboxEvent(EVENT.eventId, 'worker-a', 60_000)).toBe(true);
  });

  it('refuses to renew a lease owned by somebody else', async () => {
    await enqueueAndClaim('worker-a');
    expect(await renewModerationOutboxEvent(EVENT.eventId, 'worker-b', 60_000)).toBe(false);
  });

  it('releases a retryable failure back to pending, with backoff', async () => {
    const claimed = await enqueueAndClaim('worker-a');
    if (!claimed) throw new Error('unreachable');

    const outcome = await failModerationOutboxEvent(claimed, 'worker-a', 'timeout', false);

    expect(outcome).toEqual({ released: true, deadLettered: false });
    const [stored] = await rows();
    expect(stored?.status).toBe('pending');
    expect(stored?.lastError).toBe('timeout');
    expect(stored?.leaseOwner).toBeNull();
    // Backed off rather than immediately due again.
    expect(stored?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * Where retrying STOPS. A 409 means this external id already exists at
   * CrowdSource with a different body, and no number of attempts turns two
   * payloads into one report.
   */
  it('dead-letters a terminal failure and stops making it due', async () => {
    const claimed = await enqueueAndClaim('worker-a');
    if (!claimed) throw new Error('unreachable');

    const outcome = await failModerationOutboxEvent(claimed, 'worker-a', 'HTTP 409', true);

    expect(outcome).toEqual({ released: true, deadLettered: true });
    const [stored] = await rows();
    expect(stored?.status).toBe('dead_letter');
    // A dead letter is never claimed again — it needs a human, not an attempt.
    expect(await claimModerationOutboxEvent({ leaseOwner: 'worker-b' })).toBeNull();
  });

  it('truncates a huge error rather than refusing the write', async () => {
    const claimed = await enqueueAndClaim('worker-a');
    if (!claimed) throw new Error('unreachable');

    await failModerationOutboxEvent(claimed, 'worker-a', 'x'.repeat(5_000), false);

    expect((await rows())[0]?.lastError).toHaveLength(2_000);
  });
});
