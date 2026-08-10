import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { notifications } from '../schema/notifications';

/**
 * Notifications and the tables that travel with them, against a REAL server.
 *
 * What is left here is the notifications table itself: the conditional TTL
 * turned into a column, the CHECK that stops it drifting from the status it
 * stands for, and the closed value sets. The other tables in this schema module
 * are exercised by their own repository suites, which OWN them.
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

describe('the conditional TTL became a column, and the column cannot drift', () => {
  it('refuses a dismissed notification that does not say WHEN', async () => {
    // Without this, the sweep's column and the condition it replaced could
    // disagree — and the failure is silent in both directions: dismissed rows
    // kept forever, or rows deleted that were never dismissed.
    const insert = db.execute(sql`
      insert into ${notifications} (id, oxy_user_id, type, title, body, status)
      values ('n-bad', 'oxy-user-1', 'agent_task_complete', 'T', 'B', 'dismissed')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('notifications_dismissed_at_check');
      return true;
    });
  });

  it('refuses a dismissal timestamp on a notification that is not dismissed', async () => {
    const insert = db.execute(sql`
      insert into ${notifications} (id, oxy_user_id, type, title, body, status, dismissed_at)
      values ('n-bad2', 'oxy-user-1', 'agent_task_complete', 'T', 'B', 'read', now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('notifications_dismissed_at_check');
      return true;
    });
  });

  it('sweeps from the DISMISSAL, not from creation — the behaviour change', async () => {
    /**
     * The whole point of the column. All three rows were CREATED a year ago, so
     * a sweep measuring from `created_at` (what Mongo did) would delete every
     * one of them. Measuring from the dismissal keeps the two that were never
     * dismissed and the one dismissed recently, and reaps only the one dismissed
     * more than 90 days ago.
     */
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const longDismissed = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const justDismissed = new Date(Date.now() - 60_000).toISOString();

    await db.execute(sql`
      insert into ${notifications} (id, oxy_user_id, type, title, body, status, dismissed_at, created_at)
      values
        ('n-never',  'oxy-sweep', 'agent_task_complete', 'T', 'B', 'read',      null,                            ${yearAgo}::timestamptz),
        ('n-recent', 'oxy-sweep', 'agent_task_complete', 'T', 'B', 'dismissed', ${justDismissed}::timestamptz,   ${yearAgo}::timestamptz),
        ('n-old',    'oxy-sweep', 'agent_task_complete', 'T', 'B', 'dismissed', ${longDismissed}::timestamptz,   ${yearAgo}::timestamptz)
    `);

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${notifications} where oxy_user_id = 'oxy-sweep' order by id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['n-never', 'n-recent']);
  });
});

describe('every declared notification type is storable', () => {
  it('accepts all nine, including the five with no producer today', async () => {
    /**
     * Four of the nine ARE produced (`agent_task_complete`, `trigger_result`,
     * `oxy_service`, `chat_response_ready`), so narrowing this tuple is a `post`
     * migration taken against a census rather than a tidy-up. This test is what
     * a narrowing has to argue with.
     */
    const types = [
      'trigger_result',
      'proactive_insight',
      'daily_briefing',
      'price_alert',
      'integration_event',
      'reminder',
      'agent_task_complete',
      'chat_response_ready',
      'oxy_service',
    ];
    for (const type of types) {
      await db.execute(sql`
        insert into ${notifications} (id, oxy_user_id, type, title, body)
        values (${`n-type-${type}`}, 'oxy-types', ${type}, 'T', 'B')
      `);
    }

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${notifications} where oxy_user_id = 'oxy-types'`,
    );
    expect(rows[0]?.n).toBe('9');
  });

  it('still refuses a type outside the nine', async () => {
    const insert = db.execute(sql`
      insert into ${notifications} (id, oxy_user_id, type, title, body)
      values ('n-badtype', 'oxy-user-1', 'marketing_blast', 'T', 'B')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('notifications_type_check');
      return true;
    });
  });

  it('refuses a delivery channel outside the tuple', async () => {
    const insert = db.execute(sql`
      insert into ${notifications} (id, oxy_user_id, type, title, body, channels)
      values ('n-badchan', 'oxy-user-1', 'reminder', 'T', 'B', '{"in_app","carrier_pigeon"}')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('notifications_channels_check');
      return true;
    });
  });
});

/**
 * The `referrals` and `referral_redemptions` constraint tests moved to
 * `referralRepository.pgdb.test.ts`, in one piece and unchanged. Same reason as
 * `audio_jobs` below: the repository suite clears those tables between tests so
 * its counts are exact, and a second file seeding them turns both suites
 * flaky — which is how this was found, as a duplicate-key error on a fixture
 * rather than as a real failure.
 */

/**
 * `audio_jobs` used to be exercised here too. It moved to
 * `audioJobRepository.pgdb.test.ts` in one piece, because
 * `failOrphanedAudioJobs` is unscoped and its returned count is a property of
 * the WHOLE table — a second file writing a stalled row would join that count
 * silently. Exactly one file writes that table now, and it is not this one.
 */
