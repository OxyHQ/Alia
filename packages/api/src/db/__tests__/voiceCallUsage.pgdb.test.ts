import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isUniqueViolation, constraintNameOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { voiceCallUsage } from '../schema/usage';

/**
 * `voice_call_usage`, against a REAL server.
 *
 * The two things worth pinning are both about NUMBER TYPES, because this table
 * is the billing record for a call that already happened: a truncated duration
 * undercharges silently, and a total that is secretly a string overcharges
 * spectacularly. Neither has a mocked counterpart.
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

const insertCall = (
  id: string,
  sessionId: string,
  durationMinutes: number,
  cohostDurationMinutes = 0,
  oxyUserId = 'voice-user',
) => db.execute(sql`
  insert into ${voiceCallUsage}
    (id, session_id, oxy_user_id, routing_profile_id, provider, provider_model,
     start_time, end_time, duration_minutes, cohost_duration_minutes, cost_per_minute)
  values
    (${id}, ${sessionId}, ${oxyUserId}, 'kaana-v1', 'a-provider', 'a-model',
     now() - interval '10 minutes', now(), ${durationMinutes}, ${cohostDurationMinutes}, 0.05)
`);

describe('one session is one row', () => {
  it('refuses a second row for the same provider session id', async () => {
    await insertCall('voice-dup-1', 'session-dup', 1);

    /**
     * Load-bearing rather than decorative: the teardown path upserts the FINAL
     * record on `session_id` and plainly inserts the non-final one, so without
     * this unique a session accumulates rows and every minutes total
     * double-counts it.
     */
    await expect(insertCall('voice-dup-2', 'session-dup', 1)).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('voice_call_usage_session_id_key');
      return true;
    });
  });
});

describe('a duration is fractional minutes, and a total of them is a NUMBER', () => {
  it('keeps the fraction an integer column would have truncated', async () => {
    /**
     * The fixture is chosen so the right type and the wrong one disagree: the
     * writer computes `(endTime - startTime) / 60000`, so a 2 minute 30 second
     * call is `2.5`. Under `integer` this stores `2` — a 20% undercharge that
     * no whole-minute fixture could ever reveal.
     */
    await insertCall('voice-frac', 'session-frac', 2.5);

    const [row] = await db.execute<{ duration_minutes: number }>(
      sql`select duration_minutes from ${voiceCallUsage} where id = 'voice-frac'`,
    );
    expect(row?.duration_minutes).toBe(2.5);
  });

  it('sums to a number, unlike the bigint counters elsewhere in this schema', async () => {
    await db.execute(sql`delete from ${voiceCallUsage} where oxy_user_id = 'voice-sum-user'`);
    await insertCall('voice-sum-1', 'session-sum-1', 1.5, 0.25, 'voice-sum-user');
    await insertCall('voice-sum-2', 'session-sum-2', 2.25, 0.5, 'voice-sum-user');

    // The real entitlement query in `lib/voice-usage.ts`.
    const [row] = await db.execute<{ total: unknown }>(sql`
      select sum(duration_minutes + cohost_duration_minutes) as total
      from ${voiceCallUsage} where oxy_user_id = 'voice-sum-user'
    `);

    /**
     * `sum(double precision)` returns `double precision`, which postgres.js
     * decodes as a JS number — so this reader ports with no coercion, while the
     * same shape over a `bigint` column comes back as a string. Asserting the
     * TYPE, not just the value, is what tells those two apart: `Number(x)` is
     * correct either way and would hide the difference.
     */
    expect(typeof row?.total).toBe('number');
    expect(row?.total).toBeCloseTo(4.5, 10);
  });
});
