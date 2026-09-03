import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { authHealthMetrics, routingLogs } from '../schema/telemetry';
import { agentSessions } from '../schema/agent-sessions';
import { oauthStates } from '../schema/integrations';
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

describe('a bigint counter reaches JavaScript as a STRING', () => {
  it('needs TWO increments to tell numeric addition from concatenation', async () => {
    /**
     * postgres.js decodes `int8` as a string and drizzle types it as `number`,
     * so `total + 1` type-checks clean and is string concatenation. A test that
     * increments ONCE cannot catch it: "7" + 1 and 7 + 1 both look plausible in
     * isolation. The second increment is the first one with something to
     * concatenate onto — 7 -> 71 -> 711 rather than 7 -> 8 -> 9.
     *
     * `agent_sessions.stats_total_tokens` is the counter this bites: it
     * accumulates across every step of a session, and its own column comment
     * names the trap.
     */
    await db.execute(sql`
      insert into ${agentSessions} (id, agent_id, oxy_user_id, task, stats_total_tokens)
      values ('as-bigint', 'ag-bigint', 'oxy-user-bigint', 'count', 7)
    `);

    for (let i = 0; i < 2; i += 1) {
      const [row] = await db.execute<{ stats_total_tokens: string | number }>(
        sql`select stats_total_tokens from ${agentSessions} where id = 'as-bigint'`,
      );
      // Number() at the boundary is the fix; without it this writes '71' then '711'.
      const next = Number(row?.stats_total_tokens ?? 0) + 1;
      await db.execute(
        sql`update ${agentSessions} set stats_total_tokens = ${next} where id = 'as-bigint'`,
      );
    }

    const [final] = await db.execute<{ stats_total_tokens: string | number }>(
      sql`select stats_total_tokens from ${agentSessions} where id = 'as-bigint'`,
    );
    expect(Number(final?.stats_total_tokens)).toBe(9);
  });
});

describe('an expires_at deadline is retention ZERO, not a duration', () => {
  it('sweeps a row whose own deadline has passed and keeps one that has not', async () => {
    const target = EXPIRY_TARGETS.find((t) => t.table === oauthStates);
    if (!target) throw new Error('oauth_states has no expiry target; expiryTargets.ts changed');
    // The whole point: the column IS the deadline. A duration measured from it
    // would keep every row for that duration PAST its own expiry.
    expect(target.retentionSeconds).toBe(0);

    /**
     * Transactional so another file's full-registry sweep cannot consume this
     * fixture first, with a different
     * symptom: this case asserts only on SURVIVORS, so another file's
     * full-registry sweep reaping `os-expired` first leaves it passing while
     * measuring nothing about the sweep it calls. A silent vacuity rather than
     * a red run, which is the worse of the two to leave in place.
     */
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into ${oauthStates} (id, service, user_id, expires_at) values
          ('os-expired', 'svc', 'u', now() - interval '1 minute'),
          ('os-live',    'svc', 'u', now() + interval '1 hour')
      `);

      const results = await sweepAllExpiredRows(tx, [target]);

      // Asserted here and not before: without it, a sweep that deleted nothing
      // is indistinguishable from one whose row somebody else had already taken.
      const swept = results.find((r) => r.table === 'oauth_states');
      expect(swept?.deleted).toBeGreaterThanOrEqual(1);

      const survivors = await tx.execute<{ id: string }>(
        sql`select id from ${oauthStates} where id like 'os-%'`,
      );
      expect(survivors.map((r) => r.id)).toEqual(['os-live']);
    });
  });
});
