import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createRoutingLog,
  listRoutingLogsForAgent,
  routingStatsForAgent,
  type NewRoutingLog,
} from '../telemetry/routingLogRepository';
import { routingLogs } from '../schema/telemetry';

/**
 * `routing_logs`, against a real server.
 *
 * The load-bearing property is not the storage — it is the WIRE SHAPE. The table
 * is flat (`classification_category`, `routed_to_type`) and the shipped mobile
 * build reads `item.classification.category`, `item.routedTo?.name` and
 * `item._id`. A repository returning the flat row would satisfy every "the value
 * was stored" assertion and break the app, so the reconstruction is asserted
 * directly and by absence: the flat keys must NOT appear.
 *
 * Agent ids are namespaced per test. Instants are relative to `now` —
 * `routing_logs` is a 90-day expiry target and several files sweep the whole
 * registry.
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

const entry = (agentId: string, over: Partial<NewRoutingLog> = {}): NewRoutingLog => ({
  agentId,
  oxyUserId: 'oxy-user-1',
  triggerId: 'trigger-1',
  inboundChannel: 'webhook',
  inboundSummary: 'a customer asked about billing',
  classification: { category: 'billing', priority: 'high', confidence: 0.75 },
  routedTo: { type: 'team', id: 'team-7', name: 'Billing' },
  reasoning: 'mentions an invoice',
  ...over,
});

describe('the wire shape', () => {
  it('rebuilds the NESTED classification and routedTo the client reads', async () => {
    const agentId = 'rl-shape';
    const created = await createRoutingLog(db, entry(agentId));

    expect(created._id).toBeTruthy();
    expect(created.classification).toEqual({ category: 'billing', priority: 'high', confidence: 0.75 });
    expect(created.routedTo).toEqual({ type: 'team', id: 'team-7', name: 'Billing' });

    /**
     * The negative half, and the one that matters. `packages/app` destructures
     * `classification.category`; a repository handing back the raw row would
     * still carry the value, under `classificationCategory`, and every
     * assertion above could be rewritten to pass against it. These keys must be
     * absent from what the API returns.
     */
    expect(created).not.toHaveProperty('classificationCategory');
    expect(created).not.toHaveProperty('routedToType');
    expect(created).not.toHaveProperty('id');

    // ...while the TABLE really is flat, so this is a reconstruction rather than
    // a jsonb column wearing a different name.
    const [row] = await db.select().from(routingLogs).where(eq(routingLogs.agentId, agentId));
    expect(row.classificationCategory).toBe('billing');
    expect(row.routedToName).toBe('Billing');
  });

  it('serves routedTo as NULL for a decision routed nowhere, not a hollow object', async () => {
    const agentId = 'rl-unrouted';
    const created = await createRoutingLog(db, entry(agentId, { routedTo: null }));

    // The client's type is `| null`. A `{type: undefined, id: '', name: ''}`
    // would be truthy and render an empty destination chip.
    expect(created.routedTo).toBeNull();

    const [row] = await db.select().from(routingLogs).where(eq(routingLogs.agentId, agentId));
    expect(row.routedToType).toBeNull();
    expect(row.routedToId).toBeNull();
  });

  it('defaults status to routed and keeps confidence a number', async () => {
    const agentId = 'rl-defaults';
    const created = await createRoutingLog(db, entry(agentId, {
      classification: { category: 'x', priority: 'low', confidence: 0.25 },
    }));
    expect(created.status).toBe('routed');
    expect(created.classification.confidence).toBe(0.25);
    expect(typeof created.classification.confidence).toBe('number');
  });
});

describe('listing', () => {
  it('returns one agent\'s logs newest-first and never another agent\'s', async () => {
    const mine = 'rl-list-mine';
    const other = 'rl-list-other';
    await createRoutingLog(db, entry(mine, { inboundSummary: 'first' }));
    await createRoutingLog(db, entry(mine, { inboundSummary: 'second' }));
    await createRoutingLog(db, entry(other, { inboundSummary: 'not mine' }));

    const { logs, total } = await listRoutingLogsForAgent(db, mine, 0, 20);
    expect(total).toBe(2);
    expect(typeof total).toBe('number'); // count(*) is bigint; the cast is load-bearing
    expect(logs).toHaveLength(2);
    // The other agent's row exists and must not leak in — without seeding it,
    // an unfiltered query would pass this test unchanged.
    expect(logs.every((l) => l.agentId === mine)).toBe(true);
  });

  it('paginates with the TOTAL unaffected by the page size', async () => {
    const agentId = 'rl-paginate';
    for (let i = 0; i < 5; i += 1) {
      await createRoutingLog(db, entry(agentId, { inboundSummary: `msg ${i}` }));
    }

    const first = await listRoutingLogsForAgent(db, agentId, 0, 2);
    expect(first.logs).toHaveLength(2);
    // The count query must not inherit the limit — a `total` of 2 here is what a
    // repository counting the returned page rather than the table would report.
    expect(first.total).toBe(5);

    const last = await listRoutingLogsForAgent(db, agentId, 4, 2);
    expect(last.logs).toHaveLength(1);
    expect(last.total).toBe(5);
  });
});

describe('the stats facets', () => {
  it('groups by category, priority and status under the _id key the client destructures', async () => {
    const agentId = 'rl-stats';
    await createRoutingLog(db, entry(agentId, {
      classification: { category: 'billing', priority: 'high', confidence: 1 },
    }));
    await createRoutingLog(db, entry(agentId, {
      classification: { category: 'billing', priority: 'low', confidence: 1 },
    }));
    await createRoutingLog(db, entry(agentId, {
      classification: { category: 'support', priority: 'low', confidence: 1 },
      status: 'resolved',
    }));

    const stats = await routingStatsForAgent(db, agentId);

    expect(stats.total).toBe(3);
    expect(typeof stats.total).toBe('number');

    // `_id` rather than `category` — the Mongo `$group` key name is what the
    // client reads, so it is part of the contract.
    expect(stats.byCategory).toEqual([
      { _id: 'billing', count: 2 },
      { _id: 'support', count: 1 },
    ]);
    expect(stats.byPriority).toEqual([
      { _id: 'low', count: 2 },
      { _id: 'high', count: 1 },
    ]);
    expect(stats.byStatus).toEqual([
      { _id: 'routed', count: 2 },
      { _id: 'resolved', count: 1 },
    ]);
  });

  it('counts only the agent asked for', async () => {
    const mine = 'rl-stats-mine';
    const other = 'rl-stats-other';
    await createRoutingLog(db, entry(mine));
    await createRoutingLog(db, entry(other));
    await createRoutingLog(db, entry(other));

    expect((await routingStatsForAgent(db, mine)).total).toBe(1);
    // The positive control for the filter: the other agent's rows are really
    // there, so a total of 1 above is filtering rather than an empty table.
    expect((await routingStatsForAgent(db, other)).total).toBe(2);
  });

  it('returns empty facets and a zero total for an agent with no logs', async () => {
    const stats = await routingStatsForAgent(db, 'rl-nothing-here');
    expect(stats.total).toBe(0);
    expect(stats.byCategory).toEqual([]);
    expect(stats.byPriority).toEqual([]);
    expect(stats.byStatus).toEqual([]);
  });
});
