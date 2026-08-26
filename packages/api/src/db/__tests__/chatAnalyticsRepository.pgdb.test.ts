import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  aggregateCreditsByDay,
  aggregateUsageByDay,
  aggregateUsageByModel,
  insertChatAnalytics,
} from '../usage/chatAnalyticsRepository';
import { chatAnalytics } from '../schema/usage';
import { AliaErrorCode } from '../../lib/errors/error-codes';

/**
 * `chat_analytics`, against a real server.
 *
 * Every case is scoped to its own `oxy_user_id`, which is what all three
 * aggregates filter on — so this file cannot see another file's rows and another
 * file cannot perturb it. Instants are relative to now.
 *
 * `created_at` is a `defaultNow()` column, so the day-bucket cases set it
 * explicitly with `db.update`; the repository has no reason to accept a
 * timestamp and inventing one would be testing a parameter nothing uses.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
/** Wide enough that every fixture below falls inside it. */
const SINCE = () => daysAgo(365);

let seq = 0;
async function seed(row: {
  oxyUserId: string;
  aliaModelId: string;
  requestedModelId?: string;
  totalTokens?: number;
  latencyMs?: number;
  createdAt?: Date;
}): Promise<void> {
  const marker = `ca-marker-${String(++seq)}`;
  await insertChatAnalytics(db, {
    oxyUserId: row.oxyUserId,
    conversationId: marker,
    aliaModelId: row.aliaModelId,
    requestedModelId: row.requestedModelId ?? row.aliaModelId,
    requestedModelKind: 'legacy_alias',
    requestedProfileId: null,
    reasoningEffort: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: row.totalTokens ?? 0,
    latencyMs: row.latencyMs ?? 0,
    timeToFirstTokenMs: null,
    errorClass: null,
    cancelled: false,
    platform: 'app',
    skillNames: [],
  });
  if (row.createdAt) {
    await db
      .update(chatAnalytics)
      .set({ createdAt: row.createdAt })
      .where(sql`${chatAnalytics.conversationId} = ${marker}`);
  }
}

describe('insertChatAnalytics', () => {
  it('stores the columns the table gained, not just the ones it already had', async () => {
    const oxyUserId = 'ca-columns';
    await insertChatAnalytics(db, {
      oxyUserId,
      conversationId: 'ca-conv-1',
      aliaModelId: 'alia-v1-pro',
      requestedModelId: 'alia-v1-thinking',
      requestedModelKind: 'legacy_alias',
      requestedProfileId: 'profile:v1-pro-max',
      reasoningEffort: 'extended',
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      latencyMs: 44,
      timeToFirstTokenMs: 55,
      errorClass: 'RATE_LIMITED',
      cancelled: true,
      platform: 'web',
      skillNames: ['ca-skill-1', 'ca-skill-2'],
    });

    const [row] = await db
      .select()
      .from(chatAnalytics)
      .where(sql`${chatAnalytics.oxyUserId} = ${oxyUserId}`);
    if (!row) throw new Error('no row written');

    /**
     * `conversation_id`, `alia_model_id` and the skill column were absent from
     * the table when it landed while the hook wrote all three. A port without
     * them type-checks, inserts cleanly and throws the values away.
     *
     * The skill column is a SET now: a turn can inline two skills the person
     * picked and load a third the model matched, and the single `skill_id` it
     * replaced could only ever record one of them.
     */
    expect(row.conversationId).toBe('ca-conv-1');
    expect(row.aliaModelId).toBe('alia-v1-pro');
    expect(row.skillNames).toEqual(['ca-skill-1', 'ca-skill-2']);
    expect(row.platform).toBe('web');
    expect(row.promptTokens).toBe(11);

    /**
     * #139 ws19 and ws5. The requested identifier is a DIFFERENT value from the
     * alias in this fixture, so a column that silently mirrored the other one
     * fails here rather than passing on a row where they happen to agree.
     */
    expect(row.requestedModelId).toBe('alia-v1-thinking');
    // The SHAPE and the profile beside the string, so a later query does not
    // have to read `alia-v1-thinking` as a model choice — and the reasoning
    // request is in its own column rather than buried in that identifier.
    expect(row.requestedModelKind).toBe('legacy_alias');
    expect(row.requestedProfileId).toBe('profile:v1-pro-max');
    expect(row.reasoningEffort).toBe('extended');
    expect(row.timeToFirstTokenMs).toBe(55);
    expect(row.errorClass).toBe('RATE_LIMITED');
    expect(row.cancelled).toBe(true);
  });

  /**
   * #139 ws5: *"a row whose alias is null is a defect rather than a silent
   * fallback"*.
   *
   * A property of the SCHEMA rather than of the writer, asserted against the
   * server because that is the only thing that can refuse the write. The typed
   * repository already makes both fields required, and a type is not what stops
   * a raw `db.insert` or a backfill script.
   */
  it('refuses a row that cannot say what was asked for, or what kind of thing it was', async () => {
    const missingRequested = db
      .insert(chatAnalytics)
      .values({ oxyUserId: 'ca-null-requested', aliaModelId: 'alia-v1', requestedModelKind: 'legacy_alias' } as never);
    await expect(missingRequested).rejects.toThrow(/requested_model_id/);

    // The kind is NOT NULL for the same reason the identifier is: a row that
    // records `alia-v1-pro` without saying it is a legacy alias is a row every
    // later query is free to read as a model choice.
    const missingKind = db
      .insert(chatAnalytics)
      .values({ oxyUserId: 'ca-null-kind', aliaModelId: 'alia-v1', requestedModelId: 'alia-v1' } as never);
    await expect(missingKind).rejects.toThrow(/requested_model_kind/);

    // The positive control: the same insert with both present succeeds, so the
    // two rejections above are about the nulls and not about the statement.
    await db
      .insert(chatAnalytics)
      .values({
        oxyUserId: 'ca-null-control',
        aliaModelId: 'alia-v1',
        requestedModelId: 'alia-v1',
        requestedModelKind: 'legacy_alias',
      });
    const rows = await db
      .select()
      .from(chatAnalytics)
      .where(sql`${chatAnalytics.oxyUserId} = ${'ca-null-control'}`);
    expect(rows).toHaveLength(1);
  });

  /**
   * The provider-identifying columns are RETAINED, and this is what says so.
   *
   * They are read by nothing and written by nothing, which is the whole of what
   * #139 ws10 asks for — but they are not dropped, because `899cfd21`
   * (2026-02-11) wrote the real provider name and the real provider model id
   * into them from three call sites until `3fed699a` (2026-03-12), and no
   * measurement available from this repository can say how many such rows
   * exist. A dropped column cannot be un-dropped.
   *
   * The test therefore asserts the OPPOSITE of what a tidy-up would: the
   * columns are still there, they are nullable, and a new row leaves them null.
   */
  it('retains the provider-identifying columns while writing neither', async () => {
    // Read off `information_schema`, not off the drizzle table object: the
    // schema module and the migration can disagree, and the server decides.
    const columns = await db.execute<{ column_name: string; is_nullable: string }>(
      sql`select column_name, is_nullable from information_schema.columns
          where table_name = 'chat_analytics'`,
    );
    const byName = new Map([...columns].map((column) => [column.column_name, column.is_nullable]));

    // The floor first: the query found the real table.
    expect(byName.has('alia_model_id')).toBe(true);
    expect(byName.has('requested_model_id')).toBe(true);
    expect(byName.size).toBeGreaterThan(10);

    // Retained, and widened so the writer can stop filling them.
    expect(byName.get('model')).toBe('YES');
    expect(byName.get('provider')).toBe('YES');

    const oxyUserId = 'ca-retained-columns';
    await insertChatAnalytics(db, {
      oxyUserId,
      aliaModelId: 'alia-v1',
      requestedModelId: 'alia-v1',
      requestedModelKind: 'legacy_alias',
      requestedProfileId: 'profile:v1',
      reasoningEffort: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      timeToFirstTokenMs: null,
      errorClass: null,
      cancelled: false,
      platform: 'app',
    });

    const [row] = await db
      .select({ model: chatAnalytics.model, provider: chatAnalytics.provider })
      .from(chatAnalytics)
      .where(sql`${chatAnalytics.oxyUserId} = ${oxyUserId}`);
    // Written by nothing: the repository has no parameter for either, so a new
    // row leaves them null rather than filling them with the alias and the
    // string 'unknown' as every row since 2026-03-12 did.
    expect(row?.model).toBeNull();
    expect(row?.provider).toBeNull();
  });

  it('the read path returns no provider-identifying field', async () => {
    // The other half of "replace the provider/model fields": the columns exist
    // and no aggregate selects them, so nothing they hold can reach a response.
    const oxyUserId = 'ca-read-path';
    await seed({ oxyUserId, aliaModelId: 'alia-v1', totalTokens: 3 });

    const [byModel] = await aggregateUsageByModel(db, oxyUserId, SINCE());
    expect(Object.keys(byModel ?? {}).sort()).toEqual(['_id', 'avgLatency', 'count', 'totalTokens']);
    expect(byModel?._id).toBe('alia-v1');
  });

  it('accepts every AliaErrorCode, because the column has no CHECK', async () => {
    // The census. `error_class` is deliberately unconstrained (see the schema
    // comment); this is what would notice a CHECK arriving and silently
    // narrowing what a failing turn can report.
    const codes = Object.values(AliaErrorCode);
    expect(codes.length).toBeGreaterThanOrEqual(11);

    const oxyUserId = 'ca-error-classes';
    for (const code of codes) {
      await insertChatAnalytics(db, {
        oxyUserId,
        aliaModelId: 'alia-v1',
        requestedModelId: 'alia-v1',
        requestedModelKind: 'legacy_alias',
        requestedProfileId: null,
        reasoningEffort: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        timeToFirstTokenMs: null,
        errorClass: code,
        cancelled: false,
        platform: 'app',
      });
    }

    const rows = await db
      .select({ errorClass: chatAnalytics.errorClass })
      .from(chatAnalytics)
      .where(sql`${chatAnalytics.oxyUserId} = ${oxyUserId}`);
    expect(rows.map((row) => row.errorClass).sort()).toEqual([...codes].sort());
  });
});

describe('aggregateUsageByModel', () => {
  it('groups under the ALIA alias, not the provider model id', async () => {
    const oxyUserId = 'ca-alias-grouping';
    await seed({ oxyUserId, aliaModelId: 'alia-v1-pro', requestedModelId: 'alia-v1-pro', totalTokens: 10 });
    await seed({ oxyUserId, aliaModelId: 'alia-v1-pro', requestedModelId: 'alia-v1', totalTokens: 20 });

    const rows = await aggregateUsageByModel(db, oxyUserId, SINCE());

    /**
     * The load-bearing assertion of this whole table. Two turns the caller
     * asked for under DIFFERENT names, served by ONE Alia alias, must collapse
     * to one group named by the alias — because the route resolves that key
     * through `getAliaModel()` and DROPS whatever will not resolve. Grouped by
     * `requested_model_id` this returns two groups, and a caller who asked for
     * something unregistered would see their usage vanish from the answer.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe('alia-v1-pro');
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.totalTokens).toBe(30);
  });

  it('orders busiest first and returns NUMBERS for every aggregate', async () => {
    const oxyUserId = 'ca-model-order';
    await seed({ oxyUserId, aliaModelId: 'alia-busy', totalTokens: 100, latencyMs: 200 });
    await seed({ oxyUserId, aliaModelId: 'alia-busy', totalTokens: 300, latencyMs: 400 });
    await seed({ oxyUserId, aliaModelId: 'alia-quiet', totalTokens: 1, latencyMs: 10 });

    const rows = await aggregateUsageByModel(db, oxyUserId, SINCE());
    expect(rows.map((r) => r._id)).toEqual(['alia-busy', 'alia-quiet']);

    const busy = rows[0];
    /**
     * Three separate decodings, three separate ways to get a string:
     * `count(*)` and `sum(integer)` are `bigint`, and **`avg(integer)` is
     * `numeric`** — the one that does not look like the others. Two rows are
     * seeded for `alia-busy` precisely so a concatenation is visible: without
     * the casts `totalTokens` comes back `"100300"` and `avgLatency` `"300.00"`.
     */
    expect(typeof busy?.count).toBe('number');
    expect(typeof busy?.totalTokens).toBe('number');
    expect(typeof busy?.avgLatency).toBe('number');
    expect(busy?.totalTokens).toBe(400);
    expect(busy?.avgLatency).toBe(300);
    expect(busy?.totalTokens + 1).toBe(401);
  });
});

describe('aggregateUsageByDay', () => {
  it('buckets by UTC calendar day and orders oldest first', async () => {
    const oxyUserId = 'ca-by-day';
    // Noon UTC on three consecutive days, far enough back that "today" cannot
    // drift into the window as the suite runs.
    const day = (n: number) => {
      const d = new Date(Date.now() - n * DAY_MS);
      d.setUTCHours(12, 0, 0, 0);
      return d;
    };
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 10, latencyMs: 100, createdAt: day(30) });
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 20, latencyMs: 300, createdAt: day(30) });
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 5, latencyMs: 50, createdAt: day(29) });

    const rows = await aggregateUsageByDay(db, oxyUserId, SINCE());
    expect(rows).toHaveLength(2);

    const labelOf = (n: number) => day(n).toISOString().slice(0, 10);
    expect(rows.map((r) => r._id)).toEqual([labelOf(30), labelOf(29)]);
    expect(rows[0]?.conversations).toBe(2);
    expect(rows[0]?.totalTokens).toBe(30);
    expect(rows[0]?.avgLatency).toBe(200);
  });

  it('labels the bucket in UTC even when the session timezone is not', async () => {
    const oxyUserId = 'ca-utc-bucket';
    // 23:30 UTC. In Kiritimati (UTC+14) that is 13:30 the NEXT day, so the two
    // readings disagree — which is the whole point.
    const instant = new Date(Date.now() - 60 * DAY_MS);
    instant.setUTCHours(23, 30, 0, 0);
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 1, createdAt: instant });

    const utcLabel = instant.toISOString().slice(0, 10);
    const localLabel = new Date(instant.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(localLabel).not.toBe(utcLabel); // the fixture is only useful if they differ

    /**
     * `set local` inside a transaction, because postgres.js pools connections
     * and a bare `SET` could land on one the query never uses. Mongo's
     * `$dateToString` with no `timezone` is UTC; `to_char` on a `timestamptz`
     * uses the SESSION's zone, so without `at time zone 'UTC'` this bucket
     * silently shifts a day on any server not running UTC.
     */
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Pacific/Kiritimati'`);
      return aggregateUsageByDay(tx as unknown as ApiDatabase, oxyUserId, SINCE());
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe(utcLabel);
  });
});

describe('aggregateCreditsByDay', () => {
  it('returns tokens and a count per UTC day, oldest first', async () => {
    const oxyUserId = 'ca-credits';
    const day = (n: number) => {
      const d = new Date(Date.now() - n * DAY_MS);
      d.setUTCHours(9, 0, 0, 0);
      return d;
    };
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 7, createdAt: day(11) });
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 3, createdAt: day(10) });
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 4, createdAt: day(10) });

    const rows = await aggregateCreditsByDay(db, oxyUserId, SINCE());
    expect(rows.map((r) => r._id)).toEqual([
      day(11).toISOString().slice(0, 10),
      day(10).toISOString().slice(0, 10),
    ]);
    expect(rows[0]?.totalTokens).toBe(7);
    expect(rows[1]?.totalTokens).toBe(7);
    expect(rows[1]?.conversations).toBe(2);
    expect(typeof rows[1]?.totalTokens).toBe('number');
  });
});

describe('the window', () => {
  it('excludes rows older than `since`, and something is there to exclude', async () => {
    const oxyUserId = 'ca-window';
    const old = new Date(Date.now() - 400 * DAY_MS);
    const recent = new Date(Date.now() - 2 * DAY_MS);
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 111, createdAt: old });
    await seed({ oxyUserId, aliaModelId: 'a', totalTokens: 222, createdAt: recent });

    const inWindow = await aggregateUsageByModel(db, oxyUserId, daysAgo(30));
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]?.totalTokens).toBe(222);

    // Positive control: widen the window and the excluded row reappears, so the
    // assertion above is filtering rather than a seed that never landed.
    const wider = await aggregateUsageByModel(db, oxyUserId, daysAgo(500));
    expect(wider[0]?.totalTokens).toBe(333);
    expect(wider[0]?.count).toBe(2);
  });

  it('answers with no rows rather than an error when nothing matches', async () => {
    const rows = await aggregateUsageByDay(db, 'ca-nobody-at-all', SINCE());
    expect(rows).toEqual([]);
  });
});
