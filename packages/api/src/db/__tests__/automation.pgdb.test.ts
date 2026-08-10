import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { triggerExecutions, triggers, workflowExecutions, workflows } from '../schema/automation';

/**
 * Triggers and workflows, against a REAL server.
 *
 * The two assertions that could not live anywhere else: that a heartbeat trigger
 * carrying a schedule is STORABLE (the shape a discriminant CHECK would have
 * rejected), and that the execution sweep measures from `started_at`, which is
 * the table's only clock.
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

function triggerValues(overrides: Partial<typeof triggers.$inferInsert> = {}) {
  return {
    oxyUserId: 'oxy-user-1',
    name: 'A trigger',
    type: 'schedule' as const,
    actionPrompt: 'do the thing',
    ...overrides,
  };
}

describe('the trigger configuration groups are NOT bound to the discriminant', () => {
  it('stores an agent_heartbeat trigger that carries a schedule', async () => {
    /**
     * This is the row a `type = 'schedule'` ⟺ `schedule_type is not null` CHECK
     * would reject — and `lib/trigger-engine.ts:796` creates exactly it, then
     * schedules `type IN ('schedule','agent_heartbeat')` reading
     * `trigger.schedule` for both. The constraint that looks obviously missing
     * would have broken the engine's own writes.
     */
    await db.insert(triggers).values(
      triggerValues({
        id: 'trig-heartbeat',
        type: 'agent_heartbeat',
        scheduleType: 'interval',
        scheduleIntervalMinutes: 15,
      }),
    );

    const [row] = await db
      .select({ type: triggers.type, scheduleType: triggers.scheduleType })
      .from(triggers)
      .where(eq(triggers.id, 'trig-heartbeat'));

    expect(row).toEqual({ type: 'agent_heartbeat', scheduleType: 'interval' });
  });

  it('still closes each group\'s own value set', async () => {
    const insert = db.execute(sql`
      insert into ${triggers} (id, oxy_user_id, name, type, action_prompt, schedule_type)
      values ('trig-badsched', 'oxy-user-1', 'X', 'schedule', 'p', 'fortnightly')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('triggers_schedule_type_check');
      return true;
    });
  });
});

describe('a webhook trigger is found by its token', () => {
  it('matches on equality, which is why the column is not encrypted', async () => {
    // `lib/trigger-engine.ts:701` filters `'webhook.token': token`, and the
    // public URL is `/triggers/webhook/<token>`. Against an encrypted column
    // this predicate would match nothing — the codec's IV is random.
    await db.insert(triggers).values(
      triggerValues({
        id: 'trig-hook',
        type: 'webhook',
        webhookToken: 'tok-abc',
        enabled: true,
      }),
    );

    const [found] = await db
      .select({ id: triggers.id })
      .from(triggers)
      .where(and(eq(triggers.webhookToken, 'tok-abc'), eq(triggers.enabled, true)));

    expect(found?.id).toBe('trig-hook');
  });
});

describe('an execution names how it was started, including a way that is not a trigger kind', () => {
  it('accepts `manual`, which `triggers.type` deliberately does not', async () => {
    await db.insert(triggerExecutions).values({
      id: 'texec-manual',
      triggerId: 'trig-hook',
      oxyUserId: 'oxy-user-1',
      status: 'success',
      triggerType: 'manual',
      startedAt: new Date(),
    });

    const [row] = await db
      .select({ triggerType: triggerExecutions.triggerType })
      .from(triggerExecutions)
      .where(eq(triggerExecutions.id, 'texec-manual'));
    expect(row?.triggerType).toBe('manual');
  });

  it('refuses `manual` as a TRIGGER type, because a trigger cannot be of that kind', async () => {
    const insert = db.execute(sql`
      insert into ${triggers} (id, oxy_user_id, name, type, action_prompt)
      values ('trig-manual', 'oxy-user-1', 'X', 'manual', 'p')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('triggers_type_check');
      return true;
    });
  });

  it('keeps the execution record when its trigger is deleted', async () => {
    // No foreign key, deliberately: this records what a trigger DID, and the
    // 30-day sweep bounds how long the id can dangle.
    await db.delete(triggers).where(eq(triggers.id, 'trig-hook'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${triggerExecutions} where trigger_id = 'trig-hook'`,
    );
    expect(rows[0]?.n).toBe('1');
  });
});

describe('the execution sweep measures from started_at, the table\'s only clock', () => {
  it('reaps a run older than 30 days and keeps a recent one', async () => {
    // A JS `Date` is bound as an ISO string with an explicit cast — interpolating
    // one into a `sql` template throws in the DRIVER.
    const recent = new Date(Date.now() - 60_000).toISOString();
    const ancient = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    await db.execute(sql`
      insert into ${triggerExecutions}
        (id, trigger_id, oxy_user_id, status, trigger_type, started_at)
      values
        ('texec-recent', 'trig-x', 'oxy-user-1', 'success', 'schedule', ${recent}::timestamptz),
        ('texec-ancient', 'trig-x', 'oxy-user-1', 'success', 'schedule', ${ancient}::timestamptz)
    `);

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${triggerExecutions} where trigger_id = 'trig-x' order by id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['texec-recent']);
  });

  it('does NOT sweep workflow executions, because Mongo declared no TTL for them', async () => {
    // Adding one by analogy with `trigger_executions` would delete history the
    // source kept. The sweep above has already run; this asserts it left these.
    await db.insert(workflows).values({
      id: 'wf-1',
      oxyUserId: 'oxy-user-1',
      workflowId: 'wf-key-1',
      name: 'Flow',
    });
    await db.execute(sql`
      insert into ${workflowExecutions}
        (id, oxy_user_id, workflow_id, execution_id, status, started_at)
      values ('wexec-old', 'oxy-user-1', 'wf-key-1', 'exec-old', 'completed',
              ${new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz)
    `);

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${workflowExecutions} where id = 'wexec-old'`,
    );
    expect(rows[0]?.n).toBe('1');
  });
});

describe('workflow identity', () => {
  it('refuses a second workflow with the same caller-supplied id', async () => {
    const duplicate = db.insert(workflows).values({
      id: 'wf-2',
      oxyUserId: 'oxy-user-2',
      workflowId: 'wf-key-1',
      name: 'Impostor',
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('workflows_workflow_id_key');
      return true;
    });
  });

  it('keeps a run when its workflow is deleted', async () => {
    await db.delete(workflows).where(eq(workflows.workflowId, 'wf-key-1'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${workflowExecutions} where workflow_id = 'wf-key-1'`,
    );
    expect(rows[0]?.n).toBe('1');
  });
});
