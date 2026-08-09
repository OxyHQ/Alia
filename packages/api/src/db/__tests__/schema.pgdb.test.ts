import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, constraintNameOf } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { apiUsage, authHealthMetrics, providerHealth, routingLogs } from '../schema/telemetry';
import { leases } from '../schema/leases';

/**
 * The first Postgres tables for this service, against a REAL server.
 *
 * A mocked `insert` accepts any statement, including ones the server rejects
 * outright — and CHECK constraints, unique indexes and `ON CONFLICT` are exactly
 * what a port gets wrong. None of them has a mocked counterpart.
 *
 * Driver errors are asserted through `@oxyhq/db`'s helpers, never a message
 * regex: drizzle wraps the failure, so `code` and `constraint_name` live on
 * `cause` and the wrapper's own message is only `Failed query: …`. The
 * CONSTRAINT is named too — `isUniqueViolation` alone cannot tell the index
 * under test from any other index on the table.
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

describe('closed value sets are enforced by the DATABASE, not just the editor', () => {
  it('refuses a circuit state outside the tuple', async () => {
    // `text({ enum })` emits NO DDL — it is a TypeScript narrowing only. This is
    // what proves the CHECK beside it actually reached the server.
    const insert = db.execute(sql`
      insert into ${providerHealth} (id, provider, model_id, circuit_state)
      values ('probe-1', 'p', 'm', 'not-a-state')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('provider_health_circuit_state_check');
      return true;
    });
  });

  it('accepts every value that IS in the tuple', async () => {
    for (const state of ['closed', 'open', 'half-open']) {
      await db.execute(sql`
        insert into ${providerHealth} (id, provider, model_id, circuit_state)
        values (${`ok-${state}`}, 'p', ${state}, ${state})
      `);
    }
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${providerHealth} where id like 'ok-%'`,
    );
    expect(rows[0]?.n).toBe('3');
  });

  it('refuses a routing status outside the tuple, naming its own constraint', async () => {
    const insert = db.execute(sql`
      insert into ${routingLogs}
        (id, agent_id, oxy_user_id, inbound_channel, inbound_summary,
         classification_category, classification_priority, status)
      values ('probe-2', 'a', 'u', 'email', 's', 'c', 'p', 'not-a-status')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('routing_logs_status_check');
      return true;
    });
  });
});

describe('the unique indexes a port must not lose', () => {
  it('refuses a second provider_health row for one (provider, model)', async () => {
    await db.execute(sql`
      insert into ${providerHealth} (id, provider, model_id) values ('u-1', 'openai', 'gpt-x')
    `);
    const duplicate = db.execute(sql`
      insert into ${providerHealth} (id, provider, model_id) values ('u-2', 'openai', 'gpt-x')
    `);

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      // Named, so this cannot pass on some OTHER unique index on the table.
      expect(constraintNameOf(error)).toBe('provider_health_provider_model_key');
      return true;
    });
  });

  it('refuses a second auth metric for one (method, hour)', async () => {
    /**
     * ISO string plus an explicit cast, NOT a bare `Date`.
     *
     * Interpolating a JS `Date` into a raw `sql` template throws in the DRIVER
     * before the server ever sees the statement — `The "string" argument must be
     * of type string … Received an instance of Date` — because postgres.js has no
     * wire type to serialise it as here. It cost a red run on this very test.
     * Worth knowing that this is NOT limited to range constructors, which is
     * where the trap is usually described: it bites a plain parameter in
     * `db.execute` too.
     */
    const hour = '2026-01-01T00:00:00.000Z';
    await db.execute(sql`
      insert into ${authHealthMetrics} (id, method, hour) values ('a-1', 'jwt', ${hour}::timestamptz)
    `);
    const duplicate = db.execute(sql`
      insert into ${authHealthMetrics} (id, method, hour) values ('a-2', 'jwt', ${hour}::timestamptz)
    `);

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('auth_health_metrics_method_hour_key');
      return true;
    });
  });
});

describe('leader election: the CAS Mongo did with an aggregation pipeline', () => {
  /**
   * Acquire-or-renew as ONE statement. Claim if the row does not exist, or is
   * already mine, or the existing claim has expired — evaluated against the
   * SERVER's clock, never the application's, because two tasks whose clocks
   * disagree by more than the TTL would otherwise both believe they lead.
   */
  const acquire = (name: string, holderId: string, ttlSeconds: number) => db.execute<{ holder_id: string }>(sql`
    insert into ${leases} (name, holder_id, expires_at, acquired_at)
    values (${name}, ${holderId}, now() + make_interval(secs => ${ttlSeconds}), now())
    on conflict (name) do update
      set holder_id  = excluded.holder_id,
          expires_at = excluded.expires_at,
          acquired_at = case
            when ${leases}.holder_id = excluded.holder_id then ${leases}.acquired_at
            else excluded.acquired_at
          end
      where ${leases}.holder_id = excluded.holder_id
         or ${leases}.expires_at < now()
    returning holder_id
  `);

  it('one of two racing instances wins, and the loser is told so', async () => {
    const first = await acquire('election-1', 'task-a', 60);
    expect(first).toHaveLength(1);

    // `task-b` must NOT take a live lease. An empty RETURNING set IS the answer.
    const second = await acquire('election-1', 'task-b', 60);
    expect(second).toHaveLength(0);
  });

  it('the holder renews without changing acquired_at', async () => {
    await acquire('election-2', 'task-a', 60);
    const before = await db.execute<{ acquired_at: Date }>(
      sql`select acquired_at from ${leases} where name = 'election-2'`,
    );
    await acquire('election-2', 'task-a', 120);
    const after = await db.execute<{ acquired_at: Date }>(
      sql`select acquired_at from ${leases} where name = 'election-2'`,
    );

    // Renewal is not a change of leadership, so the clock on how long this task
    // has led must not reset.
    expect(after[0]?.acquired_at).toEqual(before[0]?.acquired_at);
  });

  it('an EXPIRED lease is claimable by another instance', async () => {
    await acquire('election-3', 'task-a', 60);
    await db.execute(sql`update ${leases} set expires_at = now() - interval '1 second' where name = 'election-3'`);

    const taken = await acquire('election-3', 'task-b', 60);

    expect(taken).toHaveLength(1);
    expect(taken[0]?.holder_id).toBe('task-b');
  });
});

describe('the expiry sweep actually deletes, and only what is expired', () => {
  it('removes rows past their retention and leaves the rest', async () => {
    const target = EXPIRY_TARGETS.find((t) => t.table === apiUsage);
    if (!target) throw new Error('api_usage has no expiry target; expiryTargets.ts changed');

    await db.execute(sql`
      insert into ${apiUsage} (id, key_id, provider, model_id, timestamp) values
        ('sweep-old',   'k', 'p', 'm', now() - interval '3 days'),
        ('sweep-fresh', 'k', 'p', 'm', now())
    `);

    const results = await sweepAllExpiredRows(db, [target]);

    const swept = results.find((r) => r.table === 'api_usage');
    expect(swept?.deleted).toBeGreaterThanOrEqual(1);

    const survivors = await db.execute<{ id: string }>(
      sql`select id from ${apiUsage} where id like 'sweep-%'`,
    );
    // The 48h retention is measured from `timestamp`: the 3-day-old row goes,
    // today's stays. A sweep that took both would look identical in the count.
    expect(survivors.map((r) => r.id)).toEqual(['sweep-fresh']);
  });
});
