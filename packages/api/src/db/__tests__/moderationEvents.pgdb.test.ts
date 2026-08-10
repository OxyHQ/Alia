import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { setUpTestDatabase, type TestDatabaseHandle } from '../testDatabase';
import {
  claimModerationEvent,
  markModerationEventIgnored,
  markModerationEventQueued,
  releaseModerationEvent,
} from '../moderation/moderationEventRepository';
import { enqueueModerationOutboxEvent } from '../moderation/outboxRepository';
import { moderationEvents, moderationOutboxes } from '../schema/moderation';

/**
 * Inbound webhook events against a REAL Postgres.
 *
 * The claim is the part that had to change shape in the port. Mongo inserted and
 * read a duplicate-key error as "somebody else has this"; here it is
 * `ON CONFLICT DO NOTHING … RETURNING`, and the EMPTY result set is the answer.
 * The difference is not stylistic — a caught exception cannot tell a duplicate
 * from a dropped connection, and answering "already processed" to a connection
 * failure retires a decision nobody ever handled. Only a real server can show
 * that the no-op path raises nothing at all.
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
  await db.execute(sql`truncate ${moderationEvents}, ${moderationOutboxes}`);
});

afterAll(async () => {
  await closePostgres();
  await database.drop();
});

const events = () => db.select().from(moderationEvents);

describe('the dedupe claim', () => {
  it('is taken by the FIRST caller only', async () => {
    expect(await claimModerationEvent('evt_1')).toBe(true);
    expect(await claimModerationEvent('evt_1')).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  it('records the claim at `claimed`, which is where a crash leaves it', async () => {
    await claimModerationEvent('evt_1');
    const [stored] = await events();
    // A row left at `claimed` means the handler neither queued work nor decided
    // there was none. Deliberately visible rather than tidied away.
    expect(stored?.state).toBe('claimed');
    expect(stored?.receivedAt).toBeInstanceOf(Date);
  });

  it('sets a deadline far enough out to outlive every redelivery', async () => {
    await claimModerationEvent('evt_1');
    const [stored] = await events();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 80 * 24 * 3_600_000);
  });

  it('lets a released claim be taken again', async () => {
    await claimModerationEvent('evt_1');
    await releaseModerationEvent('evt_1');

    // Releasing on a throw is what keeps §10.9's retry schedule able to deliver
    // the event later; never releasing would make a transient failure permanent.
    expect(await events()).toHaveLength(0);
    expect(await claimModerationEvent('evt_1')).toBe(true);
  });

  it('is a no-op to release something never claimed', async () => {
    await expect(releaseModerationEvent('never-existed')).resolves.toBeUndefined();
  });

  /**
   * Two concurrent redeliveries landing on two ECS tasks. Exactly one may win —
   * this is the whole reason the store is Postgres-backed rather than in-process.
   */
  it('gives the claim to exactly one of two concurrent callers', async () => {
    const results = await Promise.all([
      claimModerationEvent('evt_race'),
      claimModerationEvent('evt_race'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('recording what became of an event', () => {
  it('marks a decision-bearing event queued, with its payload', async () => {
    await claimModerationEvent('evt_1');

    await db.transaction(async (tx) => {
      await markModerationEventQueued(tx, {
        eventId: 'evt_1',
        type: 'case.decided',
        caseId: 'case_1',
        decision: { id: 'dec_1', revision: 1 },
      });
    });

    const [stored] = await events();
    expect(stored?.state).toBe('queued');
    expect(stored?.caseId).toBe('case_1');
    expect(stored?.queuedAt).toBeInstanceOf(Date);
    expect(stored?.payload).toEqual({ caseId: 'case_1', decision: { id: 'dec_1', revision: 1 } });
  });

  it('marks an event there is nothing to do about as ignored', async () => {
    await claimModerationEvent('evt_2');

    await markModerationEventIgnored({ eventId: 'evt_2', type: 'case.closed', caseId: 'case_9' });

    const [stored] = await events();
    // Kept rather than deleted: "did CrowdSource tell us about this case, and
    // when" is the first question asked when a report looks stuck.
    expect(stored?.state).toBe('ignored');
    expect(stored?.type).toBe('case.closed');
    expect(stored?.caseId).toBe('case_9');
  });

  it('leaves caseId alone when an unrecognised event carries none', async () => {
    await claimModerationEvent('evt_3');
    await markModerationEventIgnored({ eventId: 'evt_3', type: 'something.new' });

    const [stored] = await events();
    expect(stored?.type).toBe('something.new');
    expect(stored?.caseId).toBeNull();
  });

  it('refuses a state outside the tuple', async () => {
    await claimModerationEvent('evt_4');
    await expect(
      db.execute(sql`update ${moderationEvents} set state = 'invented' where id = 'evt_4'`),
    ).rejects.toThrow();
  });
});

/**
 * The SECOND of this service's two transactions, and the same discriminating
 * shape as intake's: the outbox append succeeds, a later statement throws, and
 * the row must be gone. If the append had escaped onto its own connection the
 * event would stay permanently deduplicated with a delivery queued that nothing
 * rolled back — a decision silently lost with a row saying it arrived.
 */
describe('the inbound transaction commits the event and its outbox row together', () => {
  it('rolls BOTH back when a later statement throws', async () => {
    await claimModerationEvent('evt_1');

    await expect(
      db.transaction(async (tx) => {
        await markModerationEventQueued(tx, {
          eventId: 'evt_1',
          type: 'case.decided',
          caseId: 'case_1',
          decision: { id: 'dec_1' },
        });
        await enqueueModerationOutboxEvent(tx, {
          eventId: 'moderation:decision.apply:evt_1',
          kind: 'decision.apply',
          payload: { eventId: 'evt_1', caseId: 'case_1' },
        });
        throw new Error('failed after both writes');
      }),
    ).rejects.toThrow('failed after both writes');

    expect(await db.select().from(moderationOutboxes)).toHaveLength(0);
    // The claim row survives at `claimed` — it was written OUTSIDE this
    // transaction, deliberately, so a redelivery is not double-run.
    expect((await events())[0]?.state).toBe('claimed');
  });

  /** The positive control: same sequence, no throw, both rows present. */
  it('commits BOTH when it does not throw', async () => {
    await claimModerationEvent('evt_1');

    await db.transaction(async (tx) => {
      await markModerationEventQueued(tx, {
        eventId: 'evt_1',
        type: 'case.decided',
        caseId: 'case_1',
        decision: { id: 'dec_1' },
      });
      await enqueueModerationOutboxEvent(tx, {
        eventId: 'moderation:decision.apply:evt_1',
        kind: 'decision.apply',
        payload: { eventId: 'evt_1', caseId: 'case_1' },
      });
    });

    expect(await db.select().from(moderationOutboxes)).toHaveLength(1);
    expect((await events())[0]?.state).toBe('queued');
  });
});
