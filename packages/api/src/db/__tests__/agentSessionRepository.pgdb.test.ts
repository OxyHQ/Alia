import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentSessionResources, agentSessions } from '../schema/agent-sessions';
import { createAgent, deleteAgentOwnedBy } from '../agents/agentRepository';
import {
  accountHasSessionWithAgent,
  agentSessionHasActiveResource,
  agentSessionIsOwnedBy,
  cancelUnsettledAgentSession,
  claimAgentSessionResource,
  countActiveAgentSessionResources,
  countAgentSessionsByDay,
  createAgentSession,
  findAgentSessionById,
  findAgentSessionContainerId,
  findAgentSessionOwnedBy,
  findAgentSessionStatus,
  findLatestAgentSession,
  listActiveAgentSessions,
  listAgentSessionHistory,
  listAgentSessionsForAudit,
  listAgentSessionsForOwner,
  listChildAgentSessions,
  listUnfinishedAgentSessions,
  markAgentSessionResourceDestroyed,
  markAllAgentSessionResourcesDestroyed,
  setAgentSessionResourcePreviewUrl,
  updateAgentSession,
} from '../agents/agentSessionRepository';

/**
 * `agentSessionRepository`, against a REAL server.
 *
 * The cases here are the ones a mock cannot express: a CHECK that ties two
 * columns together, a NULLS-LAST ordering, a `count(*)` that sees another
 * statement's insert, and an `ON CONFLICT` that decides between two answers.
 *
 * Every aggregate is scoped to ids this file owns. Several `*.pgdb.test.ts`
 * files share one database and an unscoped `count(*)` reads whatever a sibling
 * seeded.
 */

let db: ApiDatabase;
const OWNER = `oxy-owner-${Math.random().toString(36).slice(2, 10)}`;
const OTHER = `oxy-other-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const suffix = () => Math.random().toString(36).slice(2, 10);

async function seedAgent(overrides: Record<string, unknown> = {}): Promise<string> {
  const agent = await createAgent(db, {
    name: 'Runner',
    handle: `runner-${suffix()}`,
    tagline: 'runs things',
    description: 'd',
    authorOxyUserId: OWNER,
    authorName: 'Nate',
    category: 'research',
    ...overrides,
  });
  return agent._id;
}

async function seedSession(agentId: string, overrides: Record<string, unknown> = {}) {
  return await createAgentSession(db, {
    agentId,
    oxyUserId: OWNER,
    task: 'do the thing',
    ...overrides,
  });
}

describe('the plan is set and cleared as a PAIR', () => {
  /**
   * `agent_sessions_plan_shape_check` is `(plan_objective is null) = (plan_items
   * is null)`. A repository that wrote one column and not the other would be
   * refused by the server and by nothing else — there is no mocked counterpart,
   * and `tsc` is happy with either.
   */
  it('writes both columns together and reads the group back', async () => {
    const session = await seedSession(await seedAgent());
    await updateAgentSession(db, session._id, {
      plan: { objective: 'ship it', items: [{ id: 1, text: 'step', status: 'pending' }] },
    });

    const read = await findAgentSessionById(db, session._id);
    expect(read?.plan).toEqual({
      objective: 'ship it',
      items: [{ id: 1, text: 'step', status: 'pending' }],
    });
  });

  it('clears both columns together, so the group goes absent rather than half-empty', async () => {
    const session = await seedSession(await seedAgent());
    await updateAgentSession(db, session._id, {
      plan: { objective: 'ship it', items: [{ id: 1, text: 'step', status: 'pending' }] },
    });
    await updateAgentSession(db, session._id, { plan: null });

    const read = await findAgentSessionById(db, session._id);
    expect(read?.plan).toBeUndefined();
  });

  /**
   * The server's own refusal, asserted directly. Without this the CHECK could be
   * dropped from the schema and every other case here would still pass.
   */
  it('the SERVER refuses half a plan', async () => {
    const session = await seedSession(await seedAgent());
    await expect(
      db
        .update(agentSessions)
        .set({ planObjective: 'objective with no items' })
        .where(eq(agentSessions.id, session._id)),
    ).rejects.toThrow();
  });
});

describe('a patch touches only the keys it was given', () => {
  /**
   * `$set: {x: undefined}` is a NO-OP in Mongo and writes NULL in Postgres. The
   * runner patches `stats` six times a run with different members set, so a SET
   * clause built by spreading the input would erase whatever it did not mention
   * — silently, because every erased column is nullable.
   */
  it('leaves an unmentioned stats member alone', async () => {
    const session = await seedSession(await seedAgent());
    const startedAt = new Date('2026-08-01T10:00:00.000Z');

    await updateAgentSession(db, session._id, { stats: { startedAt, totalSteps: 3 } });
    await updateAgentSession(db, session._id, { stats: { totalTokens: 99 } });

    const read = await findAgentSessionById(db, session._id);
    expect(read?.stats.startedAt).toEqual(startedAt);
    expect(read?.stats.totalSteps).toBe(3);
    expect(read?.stats.totalTokens).toBe(99);
  });

  it('reports a MATCH for a patch that changes nothing, not a miss', async () => {
    const session = await seedSession(await seedAgent());
    await updateAgentSession(db, session._id, { status: 'running' });
    // `rowCount` behaves like Mongo's `matchedCount`, and the callers read it
    // as "did the session exist" rather than as "did anything change".
    expect(await updateAgentSession(db, session._id, { status: 'running' })).toBe(1);
  });

  it('reports zero for a session that is gone', async () => {
    expect(await updateAgentSession(db, `missing-${suffix()}`, { status: 'failed' })).toBe(0);
  });
});

describe('cancelling a session that may already have settled', () => {
  /**
   * The executor's timeout handler races the run it is trying to stop. A
   * read-then-write would overwrite a real result with `cancelled`; the status
   * predicate is in the statement, so it cannot.
   */
  it('refuses a completed session', async () => {
    const session = await seedSession(await seedAgent());
    await updateAgentSession(db, session._id, { status: 'completed', result: 'the real answer' });

    expect(await cancelUnsettledAgentSession(db, session._id, 'timeout')).toBe(false);

    const read = await findAgentSessionById(db, session._id);
    expect(read?.status).toBe('completed');
    expect(read?.result).toBe('the real answer');
  });

  it('cancels a running one', async () => {
    const session = await seedSession(await seedAgent(), { status: 'running' });
    expect(await cancelUnsettledAgentSession(db, session._id, 'timeout')).toBe(true);
    expect(await findAgentSessionStatus(db, session._id)).toBe('cancelled');
  });
});

describe('the resources a session claims', () => {
  it('claims a container once, whichever tool call gets there first', async () => {
    const session = await seedSession(await seedAgent());

    const first = await claimAgentSessionResource(db, session._id, {
      type: 'container',
      resourceId: 'docker-1',
    });
    const second = await claimAgentSessionResource(db, session._id, {
      type: 'container',
      resourceId: 'docker-1',
    });

    // `RETURNING` on a DO NOTHING is empty, which is what distinguishes
    // "inserted" from "already there" without a second read.
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await countActiveAgentSessionResources(db, session._id)).toBe(1);
  });

  /**
   * The `maxVMs` gate. The hydrated document handed `tools.ts` an array loaded
   * when the session was, so two creations in one run both saw the count from
   * before either of them — this asserts the gate reads the table.
   */
  it('counts what is there NOW, not what was there at load', async () => {
    const session = await seedSession(await seedAgent());
    expect(await countActiveAgentSessionResources(db, session._id)).toBe(0);
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'a' });
    expect(await countActiveAgentSessionResources(db, session._id)).toBe(1);
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'b' });
    expect(await countActiveAgentSessionResources(db, session._id)).toBe(2);
    await markAgentSessionResourceDestroyed(db, session._id, 'a');
    expect(await countActiveAgentSessionResources(db, session._id)).toBe(1);
  });

  /**
   * The container id an agent tool passes comes from the MODEL. This predicate
   * is the only thing between it and another session's sandbox.
   */
  it('does not see another session’s container', async () => {
    const agentId = await seedAgent();
    const mine = await seedSession(agentId);
    const theirs = await seedSession(agentId, { oxyUserId: OTHER });
    await claimAgentSessionResource(db, theirs._id, { type: 'container', resourceId: 'theirs-1' });

    expect(await agentSessionHasActiveResource(db, theirs._id, 'theirs-1')).toBe(true);
    expect(await agentSessionHasActiveResource(db, mine._id, 'theirs-1')).toBe(false);
  });

  it('does not see a destroyed container of its own', async () => {
    const session = await seedSession(await seedAgent());
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'gone' });
    await markAgentSessionResourceDestroyed(db, session._id, 'gone');
    expect(await agentSessionHasActiveResource(db, session._id, 'gone')).toBe(false);
  });

  /**
   * Cleanup returns exactly the ids it changed, so the caller destroys those and
   * not a stale list. A second cleanup returns nothing rather than asking the
   * sandbox provider to destroy the same containers again.
   */
  it('claims the active ones for destruction, once', async () => {
    const session = await seedSession(await seedAgent());
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'x' });
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'y' });
    await markAgentSessionResourceDestroyed(db, session._id, 'y');

    expect(await markAllAgentSessionResourcesDestroyed(db, session._id)).toEqual(['x']);
    expect(await markAllAgentSessionResourcesDestroyed(db, session._id)).toEqual([]);
  });

  it('records a preview URL against the claimed resource', async () => {
    const session = await seedSession(await seedAgent());
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'p' });
    expect(
      await setAgentSessionResourcePreviewUrl(db, session._id, 'p', 'https://preview.example'),
    ).toBe(true);

    const [row] = await db
      .select({ previewUrl: agentSessionResources.previewUrl })
      .from(agentSessionResources)
      .where(eq(agentSessionResources.sessionId, session._id));
    expect(row.previewUrl).toBe('https://preview.example');
  });

  /**
   * `routes/agents/files.ts` serves workspace files out of whichever container
   * this returns. A destroyed one must not be it.
   */
  it('resolves only an ACTIVE container for the file routes', async () => {
    const session = await seedSession(await seedAgent());
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'dead' });
    await markAgentSessionResourceDestroyed(db, session._id, 'dead');
    expect(await findAgentSessionContainerId(db, session._id)).toBeNull();

    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'live' });
    expect(await findAgentSessionContainerId(db, session._id)).toBe('live');
  });

  it('goes with the session, because the rows WERE the session document', async () => {
    const session = await seedSession(await seedAgent());
    await claimAgentSessionResource(db, session._id, { type: 'container', resourceId: 'c' });
    await db.delete(agentSessions).where(eq(agentSessions.id, session._id));

    const [remaining] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentSessionResources)
      .where(eq(agentSessionResources.sessionId, session._id));
    expect(remaining.total).toBe(0);
  });
});

describe('ownership is a predicate, never a comparison the caller makes', () => {
  it('does not hand a stranger somebody else’s session', async () => {
    const session = await seedSession(await seedAgent());
    expect(await findAgentSessionOwnedBy(db, session._id, OWNER)).not.toBeNull();
    expect(await findAgentSessionOwnedBy(db, session._id, OTHER)).toBeNull();
    expect(await agentSessionIsOwnedBy(db, session._id, OTHER)).toBe(false);
  });

  it('answers the socket room gate with a boolean', async () => {
    const agentId = await seedAgent();
    expect(await accountHasSessionWithAgent(db, agentId, OWNER)).toBe(false);
    await seedSession(agentId);
    expect(await accountHasSessionWithAgent(db, agentId, OWNER)).toBe(true);
    expect(await accountHasSessionWithAgent(db, agentId, OTHER)).toBe(false);
  });
});

describe('the task listings', () => {
  /**
   * Mongo sorted `{'stats.completedAt': -1, createdAt: -1}` and puts a missing
   * value LAST on a descending sort; Postgres defaults to NULLS FIRST there. So
   * a cancelled session that never completed would HEAD the history page — the
   * quietest possible ordering bug, since every row is real and present.
   */
  it('puts a session that never completed at the END of the history page', async () => {
    const agentId = await seedAgent();
    const user = `oxy-history-${suffix()}`;
    const older = await createAgentSession(db, { agentId, oxyUserId: user, task: 'older' });
    const newer = await createAgentSession(db, { agentId, oxyUserId: user, task: 'newer' });
    const never = await createAgentSession(db, { agentId, oxyUserId: user, task: 'never' });

    await updateAgentSession(db, older._id, {
      status: 'completed',
      stats: { completedAt: new Date('2026-08-01T00:00:00.000Z') },
    });
    await updateAgentSession(db, newer._id, {
      status: 'completed',
      stats: { completedAt: new Date('2026-08-02T00:00:00.000Z') },
    });
    await updateAgentSession(db, never._id, { status: 'cancelled' });

    const { sessions, total } = await listAgentSessionHistory(db, user, { limit: 10, offset: 0 });
    expect(total).toBe(3);
    expect(sessions.map((s) => s.task)).toEqual(['newer', 'older', 'never']);
  });

  it('carries the agent as an OBJECT, which is the response the app reads', async () => {
    const agentId = await seedAgent({ name: 'Cardable', avatar: 'file-9' });
    const user = `oxy-active-${suffix()}`;
    await createAgentSession(db, { agentId, oxyUserId: user, task: 'live', status: 'running' });

    const [session] = await listActiveAgentSessions(db, user, 10);
    expect(session.agentId).toMatchObject({ _id: agentId, name: 'Cardable', avatar: 'file-9' });
  });

  /**
   * `agent_sessions.agent_id` carries NO foreign key, so a session outlives its
   * agent — and `populate` answered that with null. An INNER join here would
   * drop somebody's own task history from their own page.
   */
  it('keeps a session whose agent was deleted, with a null agent', async () => {
    const agentId = await seedAgent();
    const user = `oxy-orphan-${suffix()}`;
    await createAgentSession(db, { agentId, oxyUserId: user, task: 'orphaned', status: 'running' });
    await deleteAgentOwnedBy(db, agentId, OWNER);

    const listed = await listActiveAgentSessions(db, user, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].agentId).toBeNull();
  });

  it('lists one agent’s sessions for their owner only', async () => {
    const agentId = await seedAgent();
    await seedSession(agentId, { task: 'mine' });
    await seedSession(agentId, { task: 'theirs', oxyUserId: OTHER });

    const mine = await listAgentSessionsForOwner(db, agentId, OWNER, 10);
    expect(mine.map((s) => s.task)).toEqual(['mine']);
  });

  /**
   * The delegation avatars on a task card. A child whose agent is gone is
   * DROPPED rather than reported with a null, because `childAgents[]` is not
   * nullable on the client.
   */
  it('attaches child agents, and drops a child whose agent is gone', async () => {
    const user = `oxy-children-${suffix()}`;
    const parentAgent = await seedAgent();
    const childAgent = await seedAgent({ name: 'Child' });
    const doomedAgent = await seedAgent({ name: 'Doomed' });

    const parent = await createAgentSession(db, { agentId: parentAgent, oxyUserId: user, task: 'p' });
    await createAgentSession(db, {
      agentId: childAgent,
      oxyUserId: user,
      task: 'c1',
      parentSessionId: parent._id,
    });
    await createAgentSession(db, {
      agentId: doomedAgent,
      oxyUserId: user,
      task: 'c2',
      parentSessionId: parent._id,
    });
    await deleteAgentOwnedBy(db, doomedAgent, OWNER);

    const children = await listChildAgentSessions(db, [parent._id], user);
    expect(children.map((c) => c.agent.name)).toEqual(['Child']);
  });

  /**
   * The order is ON SCREEN, so it is asserted with TWO rows.
   *
   * `task-card.tsx` iterates `childAgents` to draw a row of avatars and the
   * tasks list polls every ten seconds, so an unordered `inArray` shows as
   * avatars reshuffling between polls. A single-child fixture cannot see that —
   * any order is the right order for one row — which is why this seeds three
   * and pins the sequence.
   *
   * The `created_at` values are stamped explicitly: the column is truncated to
   * milliseconds, and three inserts in one millisecond would tie and make this
   * assert the clock rather than the ORDER BY.
   */
  it('returns a parent’s children in delegation order, not in plan order', async () => {
    const user = `oxy-order-${suffix()}`;
    const parentAgent = await seedAgent();
    const first = await seedAgent({ name: 'First' });
    const second = await seedAgent({ name: 'Second' });
    const third = await seedAgent({ name: 'Third' });

    const parent = await createAgentSession(db, {
      agentId: parentAgent,
      oxyUserId: user,
      task: 'p',
    });

    const base = Date.now();
    // Inserted NEWEST first, so a query that simply returns insertion order
    // would produce the reverse of what this expects.
    for (const [offset, agentId] of [
      [2000, third],
      [1000, second],
      [0, first],
    ] as const) {
      await db.insert(agentSessions).values({
        agentId,
        oxyUserId: user,
        task: 'child',
        parentSessionId: parent._id,
        createdAt: new Date(base + offset),
      });
    }

    const children = await listChildAgentSessions(db, [parent._id], user);
    expect(children.map((c) => c.agent.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('does not attach another account’s children', async () => {
    const user = `oxy-children-${suffix()}`;
    const agentId = await seedAgent();
    const parent = await createAgentSession(db, { agentId, oxyUserId: user, task: 'p' });
    await createAgentSession(db, {
      agentId,
      oxyUserId: OTHER,
      task: 'not-yours',
      parentSessionId: parent._id,
    });

    expect(await listChildAgentSessions(db, [parent._id], user)).toEqual([]);
  });
});

describe('the reads the runner and the routes make', () => {
  it('finds the newest session of an agent in the named states', async () => {
    const agentId = await seedAgent();
    await seedSession(agentId, { status: 'failed' });
    const running = await seedSession(agentId, { status: 'running' });

    expect(await findLatestAgentSession(db, agentId, ['running', 'completed'])).toEqual({
      _id: running._id,
    });
    expect(await findLatestAgentSession(db, agentId, [])).toBeNull();
  });

  it('lists the unfinished sessions a status change cancels', async () => {
    const agentId = await seedAgent();
    await seedSession(agentId, { status: 'queued' });
    await seedSession(agentId, { status: 'running' });
    await seedSession(agentId, { status: 'completed' });

    const unfinished = await listUnfinishedAgentSessions(db, agentId);
    expect(unfinished.map((s) => s.status).sort()).toEqual(['queued', 'running']);
  });

  /**
   * `to_char` over a `timestamptz` uses the SESSION time zone, so an unqualified
   * version puts a session in a different square depending on which server
   * answered. This session is at 00:30 UTC on the 6th, which in Los Angeles is
   * 17:30 on the 5th — a different SQUARE, not merely a different clock.
   *
   * `set LOCAL` inside a transaction, not `set` on the handle: postgres.js is a
   * POOL, so a bare `set time zone` lands on whichever connection served it and
   * the query under test may run on another — which makes the whole case
   * vacuous, silently. It measured nothing until this was a transaction, and the
   * mutation that removes `at time zone 'UTC'` survived it.
   */
  it('groups the activity grid by UTC day, not by the server’s zone', async () => {
    const agentId = await seedAgent();
    await db.insert(agentSessions).values({
      agentId,
      oxyUserId: OWNER,
      task: 'late',
      createdAt: new Date('2026-08-06T00:30:00.000Z'),
    });

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'America/Los_Angeles'`);

      // The control: the session zone really did change on THIS connection, so a
      // passing assertion below cannot be a connection that stayed on UTC.
      const [zone] = await tx.execute<{ zone: string }>(
        sql`select current_setting('TimeZone') as zone`,
      );
      expect(zone.zone).toBe('America/Los_Angeles');

      const grid = await countAgentSessionsByDay(tx, agentId, new Date('2026-08-01T00:00:00.000Z'));
      expect(grid).toEqual([{ date: '2026-08-06', count: 1 }]);
    });
  });

  it('narrows the audit export to one agent and one window', async () => {
    const user = `oxy-audit-${suffix()}`;
    const wanted = await seedAgent();
    const other = await seedAgent();
    await db.insert(agentSessions).values([
      { agentId: wanted, oxyUserId: user, task: 'in', createdAt: new Date('2026-08-10T00:00:00.000Z') },
      { agentId: wanted, oxyUserId: user, task: 'early', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      { agentId: other, oxyUserId: user, task: 'wrong-agent', createdAt: new Date('2026-08-10T00:00:00.000Z') },
    ]);

    const rows = await listAgentSessionsForAudit(db, user, {
      agentId: wanted,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(rows.map((r) => r.task)).toEqual(['in']);
  });
});

describe('the columns whose TYPE is the whole point', () => {
  /**
   * `stats_total_tokens` is `bigint`. A long session's token count can exceed
   * 2^31, and `integer` would have refused this write — which is the failure
   * this column type exists to prevent, discovered on somebody's longest run.
   */
  it('stores a token count past the integer maximum, as a NUMBER', async () => {
    const session = await seedSession(await seedAgent());
    const huge = 5_000_000_000;
    await updateAgentSession(db, session._id, { stats: { totalTokens: huge } });

    const read = await findAgentSessionById(db, session._id);
    expect(read?.stats.totalTokens).toBe(huge);
    expect(typeof read?.stats.totalTokens).toBe('number');
  });

  /**
   * The credit reservation is `default: undefined` in Mongoose: absent as a
   * GROUP or whole. Synthesising zeros would make "took no credits" and "took a
   * reservation of nothing" the same record, and `runner.ts` refunds on the
   * first and not the second.
   */
  it('leaves the credit reservation ABSENT rather than filling it with zeros', async () => {
    const withoutCredits = await seedSession(await seedAgent());
    expect((await findAgentSessionById(db, withoutCredits._id))?.creditReservation).toBeUndefined();

    const withCredits = await createAgentSession(db, {
      agentId: await seedAgent(),
      oxyUserId: OWNER,
      task: 'paid',
      creditReservation: {
        userId: OWNER,
        creditsReserved: 15,
        initialFreeCredits: 2,
        initialPaidCredits: 13,
      },
    });
    expect((await findAgentSessionById(db, withCredits._id))?.creditReservation).toEqual({
      userId: OWNER,
      creditsReserved: 15,
      initialFreeCredits: 2,
      initialPaidCredits: 13,
    });
  });

  /**
   * `messages` has exactly one writer — `routes/oxy-service-events.ts` — and no
   * reader. Ported because the shape is the record; asserted because a
   * write-only column is the kind nobody notices has stopped working.
   */
  it('round-trips the write-only messages array', async () => {
    const session = await createAgentSession(db, {
      agentId: await seedAgent(),
      oxyUserId: OWNER,
      task: 'autonomous',
      messages: [{ role: 'system', content: 'Autonomous Oxy service event execution', timestamp: new Date() }],
    });
    const read = await findAgentSessionById(db, session._id);
    expect(read?.messages).toHaveLength(1);
    expect(read?.messages[0].content).toBe('Autonomous Oxy service event execution');
  });
});
