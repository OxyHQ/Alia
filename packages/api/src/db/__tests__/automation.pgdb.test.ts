import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxy.so/db';
import { sweepAllExpiredRows } from '@oxy.so/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { workflowExecutions, workflows } from '../schema/automation';

/**
 * Workflows, against a REAL server: their identity, and that no expiry sweep
 * touches their run history.
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

describe('workflow run history', () => {
  it('does NOT sweep workflow executions, because Mongo declared no TTL for them', async () => {
    // Adding one by analogy with a short-lived table would delete history the
    // source kept.
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
