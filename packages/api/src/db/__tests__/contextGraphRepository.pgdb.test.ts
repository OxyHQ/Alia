import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createStrategyIfAbsent,
  findActiveStrategy,
  findSourceScores,
  insertMissingSources,
  recordSourceRun,
  recordStrategyRun,
  upsertContextEdge,
  upsertContextNode,
} from '../autonomy/contextGraphRepository';
import {
  contextEdges,
  contextNodes,
  contextSources,
  retrievalStrategies,
} from '../schema/context-graph';

/**
 * The context-graph repository, against a real server.
 *
 * The whole domain is behind a flag that is off, so production row counts prove
 * nothing and every claim has to be established here instead. Three of these
 * cases cannot be written against a mock at all: `on conflict` no-op semantics,
 * a real foreign key, and the increment's column NAME — a mocked insert accepts
 * any statement, including one the server rejects.
 *
 * Users are namespaced `cgr-*` per case: the pgdb suite shares ONE database
 * across files, so anything that counts or aggregates is scoped to ids this
 * file owns.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const readSource = async (oxyUserId: string, sourceKey: string) => {
  const [row] = await db
    .select()
    .from(contextSources)
    .where(
      and(eq(contextSources.oxyUserId, oxyUserId), eq(contextSources.sourceKey, sourceKey)),
    );
  return row;
};

describe('recording a read against a source', () => {
  /**
   * THE case this repository exists for.
   *
   * `learnFromRun` sets exactly one of the two timestamps per run and left the
   * other `undefined`, which Mongo drops from a `$set`. Translated literally,
   * the same statement writes NULL — so a failed run would erase the last
   * success, and a successful one the last error, with every write reporting
   * success and no error anywhere. Nothing else in the suite would notice.
   *
   * The assertion is deliberately on the SURVIVING timestamp, not the written
   * one: a repository that wrote both correctly and a repository that nulled
   * the opposite one are indistinguishable if you only check what you just set.
   */
  it('leaves the opposite timestamp alone when a run supplies only one', async () => {
    const user = 'cgr-timestamps';
    const success = new Date('2026-03-01T10:00:00.000Z');
    const failure = new Date('2026-03-02T11:00:00.000Z');

    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'email',
      kind: 'email',
      label: 'email',
      successfulReadsDelta: 1,
      lastSuccessAt: success,
      freshnessScore: 0.9,
    });
    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'email',
      kind: 'email',
      label: 'email',
      failedReadsDelta: 1,
      lastErrorAt: failure,
      freshnessScore: 0.4,
    });

    const row = await readSource(user, 'email');
    expect(row?.lastErrorAt).toEqual(failure);
    // The one that must NOT have been touched.
    expect(row?.lastSuccessAt).toEqual(success);
  });

  /**
   * `$inc` on a Mongo upsert applies to the INSERT too, so a first run stores
   * the delta rather than zero. Both halves are asserted because they fail
   * differently: getting the insert wrong stores 0 forever, getting the
   * conflict clause wrong pins the counter at 1.
   */
  it('increments from the inserted value, then from the stored one', async () => {
    const user = 'cgr-counters';

    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'notes',
      kind: 'notes',
      label: 'notes',
      successfulReadsDelta: 1,
      failedReadsDelta: 0,
    });
    expect((await readSource(user, 'notes'))?.successfulReads).toBe(1);

    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'notes',
      kind: 'notes',
      label: 'notes',
      successfulReadsDelta: 1,
      failedReadsDelta: 0,
    });
    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'notes',
      kind: 'notes',
      label: 'notes',
      successfulReadsDelta: 0,
      failedReadsDelta: 1,
    });

    const row = await readSource(user, 'notes');
    expect(row?.successfulReads).toBe(2);
    expect(row?.failedReads).toBe(1);
  });

  /** `$setOnInsert`: a later run must not relabel or reclassify the row. */
  it('does not overwrite kind or label on a subsequent run', async () => {
    const user = 'cgr-setoninsert';

    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'oxy:calendarapp',
      kind: 'oxy_service',
      label: 'calendarapp',
      successfulReadsDelta: 1,
    });
    await recordSourceRun(db, {
      oxyUserId: user,
      sourceKey: 'oxy:calendarapp',
      kind: 'unknown',
      label: 'something-else',
      successfulReadsDelta: 1,
    });

    const row = await readSource(user, 'oxy:calendarapp');
    expect(row?.kind).toBe('oxy_service');
    expect(row?.label).toBe('calendarapp');
    // The run itself still landed, so the case is not passing vacuously.
    expect(row?.successfulReads).toBe(2);
  });
});

describe('seeding the default sources', () => {
  it('inserts what is missing and ignores what already exists', async () => {
    const user = 'cgr-seed';
    const rows = ['email', 'notes', 'files'].map((sourceKey) => ({
      oxyUserId: user,
      sourceKey,
      kind: 'unknown' as const,
      label: sourceKey,
      freshnessScore: 0.5,
      precisionScore: 0.5,
      avgCostScore: 0.5,
    }));

    await insertMissingSources(db, rows);
    // A duplicate batch must not throw — the source swallowed E11000 here.
    await expect(insertMissingSources(db, rows)).resolves.toBeUndefined();

    const scores = await findSourceScores(db, user, ['email', 'notes', 'files']);
    expect(scores).toHaveLength(3);
    // Negative half: the read is scoped, so another user's rows are invisible.
    expect(await findSourceScores(db, 'cgr-seed-other', ['email'])).toHaveLength(0);
    // And it filters by key rather than returning everything the user has.
    expect(await findSourceScores(db, user, ['email'])).toHaveLength(1);
  });

  it('returns nothing for an empty key list without issuing a query', async () => {
    expect(await findSourceScores(db, 'cgr-seed', [])).toEqual([]);
  });
});

describe('nodes and the edge between them', () => {
  it('returns the same row on re-upsert and updates only the patch fields', async () => {
    const user = 'cgr-nodes';
    const first = await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'message:user:abc',
      type: 'memory',
      label: 'original label',
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
      freshnessScore: 0.5,
    });

    const second = await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'message:user:abc',
      type: 'conversation',
      label: 'a different label',
      lastSeenAt: new Date('2026-03-05T00:00:00.000Z'),
      freshnessScore: 0.9,
    });

    // Same row — the id is what `learnFromRun` hands to the edge.
    expect(second.id).toBe(first.id);
    expect(second.lastSeenAt).toEqual(new Date('2026-03-05T00:00:00.000Z'));
    expect(second.freshnessScore).toBe(0.9);
    // Insert-only fields survived.
    expect(second.type).toBe('memory');
    expect(second.label).toBe('original label');
  });

  it('leaves freshness alone when the patch omits it', async () => {
    const user = 'cgr-node-omit';
    await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'n1',
      type: 'service',
      label: 'n1',
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
      freshnessScore: 0.95,
    });
    const after = await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'n1',
      type: 'service',
      label: 'n1',
      lastSeenAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    expect(after.freshnessScore).toBe(0.95);
    expect(after.lastSeenAt).toEqual(new Date('2026-03-02T00:00:00.000Z'));
  });

  it('upserts an edge on the four-column unique, then cascades with its node', async () => {
    const user = 'cgr-edges';
    const from = await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'from',
      type: 'memory',
      label: 'from',
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const to = await upsertContextNode(db, {
      oxyUserId: user,
      nodeKey: 'to',
      type: 'memory',
      label: 'to',
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    await upsertContextEdge(db, {
      oxyUserId: user,
      fromNodeId: from.id,
      toNodeId: to.id,
      edgeType: 'related_to',
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
      weight: 0.4,
    });
    await upsertContextEdge(db, {
      oxyUserId: user,
      fromNodeId: from.id,
      toNodeId: to.id,
      edgeType: 'related_to',
      lastSeenAt: new Date('2026-03-02T00:00:00.000Z'),
      weight: 0.9,
    });

    const edges = await db
      .select()
      .from(contextEdges)
      .where(eq(contextEdges.oxyUserId, user));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBe(0.9);

    /**
     * The foreign keys are real, and `on delete cascade` is what keeps the
     * graph consistent once a retention policy deletes a node. No code deletes
     * one today, so this is the only place the constraint is exercised at all.
     */
    await db.delete(contextNodes).where(eq(contextNodes.id, from.id));
    expect(
      await db.select().from(contextEdges).where(eq(contextEdges.oxyUserId, user)),
    ).toHaveLength(0);
  });

  it('refuses an edge whose endpoint does not exist', async () => {
    await expect(
      upsertContextEdge(db, {
        oxyUserId: 'cgr-fk',
        fromNodeId: '00000000-0000-7000-8000-000000000000',
        toNodeId: '00000000-0000-7000-8000-000000000001',
        edgeType: 'related_to',
        lastSeenAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('retrieval strategies', () => {
  it('creates one, and a second attempt is a no-op rather than a throw', async () => {
    const user = 'cgr-strategy-create';
    const params = {
      oxyUserId: user,
      intent: 'research' as const,
      name: 'research-default',
      sourceSteps: [{ sourceKey: 'web', order: 1, required: true }],
    };

    await createStrategyIfAbsent(db, params);
    /**
     * Mongoose's `create` threw E11000 here, uncaught, rejecting the whole
     * recall. `do nothing` makes the loser of the race a no-op — a behaviour
     * change, pinned so it is not read as accidental.
     */
    await expect(createStrategyIfAbsent(db, params)).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(retrievalStrategies)
      .where(eq(retrievalStrategies.oxyUserId, user));
    expect(rows).toHaveLength(1);
    expect(await findActiveStrategy(db, user, 'research')).toBeDefined();
    // Negative half: a different intent has none.
    expect(await findActiveStrategy(db, user, 'monitoring')).toBeUndefined();
  });

  it('inserts on the first run, then increments the row it found', async () => {
    const user = 'cgr-strategy-run';
    const run = {
      oxyUserId: user,
      intent: 'general' as const,
      name: 'general-default',
      sourceSteps: [],
      lastUsedAt: new Date('2026-03-01T00:00:00.000Z'),
      avgLatencyMs: 120,
    };

    await recordStrategyRun(db, { ...run, successDelta: 1, failureDelta: 0 });
    const afterFirst = await findActiveStrategy(db, user, 'general');
    expect(afterFirst?.successCount).toBe(1);

    await recordStrategyRun(db, { ...run, successDelta: 1, failureDelta: 0 });
    await recordStrategyRun(db, { ...run, successDelta: 0, failureDelta: 1 });

    const rows = await db
      .select()
      .from(retrievalStrategies)
      .where(eq(retrievalStrategies.oxyUserId, user));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.successCount).toBe(2);
    expect(rows[0]?.failureCount).toBe(1);
  });

  /**
   * The reason `recordStrategyRun` is two statements instead of one upsert.
   *
   * The source matched `{oxyUserId, intent, active: true}` while the unique is
   * `(oxy_user_id, intent, name)`. An `on conflict` on that unique would target
   * `<intent>-default` BY NAME and quietly insert a second row beside an active
   * strategy stored under any other name. This asserts the update found the
   * active row, which is the assertion that fails if anybody simplifies it.
   */
  it('increments an ACTIVE strategy stored under a different name', async () => {
    const user = 'cgr-strategy-named';
    await createStrategyIfAbsent(db, {
      oxyUserId: user,
      intent: 'meeting_prep',
      name: 'hand-tuned',
      sourceSteps: [],
    });

    await recordStrategyRun(db, {
      oxyUserId: user,
      intent: 'meeting_prep',
      name: 'meeting_prep-default',
      sourceSteps: [],
      successDelta: 1,
      failureDelta: 0,
      lastUsedAt: new Date('2026-03-01T00:00:00.000Z'),
      avgLatencyMs: 90,
    });

    const rows = await db
      .select()
      .from(retrievalStrategies)
      .where(eq(retrievalStrategies.oxyUserId, user));
    // One row, still the hand-tuned one, and it is the one that got the run.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('hand-tuned');
    expect(rows[0]?.successCount).toBe(1);
  });

  it('ignores an INACTIVE strategy and inserts the default beside it', async () => {
    const user = 'cgr-strategy-inactive';
    await db.insert(retrievalStrategies).values({
      oxyUserId: user,
      intent: 'inbox_digest',
      name: 'retired',
      active: false,
      sourceSteps: [],
    });

    await recordStrategyRun(db, {
      oxyUserId: user,
      intent: 'inbox_digest',
      name: 'inbox_digest-default',
      sourceSteps: [],
      successDelta: 1,
      failureDelta: 0,
      lastUsedAt: new Date('2026-03-01T00:00:00.000Z'),
      avgLatencyMs: 90,
    });

    const rows = await db
      .select()
      .from(retrievalStrategies)
      .where(eq(retrievalStrategies.oxyUserId, user));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'retired')?.successCount).toBe(0);
    expect(rows.find((r) => r.name === 'inbox_digest-default')?.successCount).toBe(1);
  });
});
