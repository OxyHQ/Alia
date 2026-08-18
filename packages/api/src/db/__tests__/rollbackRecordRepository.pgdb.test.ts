import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { insertRollbackRecord } from '../agents/rollbackRecordRepository';
import { rollbackRecords } from '../schema/agents-support';

/**
 * The rollback-record repository against a real server.
 *
 * The table has one writer and NO reader, so nothing downstream would ever
 * notice a column landing NULL — which is precisely why the optional keys are
 * asserted in both directions here. `lib/agent/governance.ts` writes an audit
 * trail of what an agent did; a silently empty `before_state` is a record that
 * has stopped being one.
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

const OWNER = 'rrr-owner';

const base = {
  oxyUserId: OWNER,
  sessionId: 'rrr-session',
  toolName: 'write_file',
  riskLevel: 'R1',
  args: { path: 'notes.txt', content: 'hi' },
  status: 'open',
} as const;

describe('recording a reversible action', () => {
  it('stores the tool call, its arguments and the window it opened', async () => {
    const executedAt = new Date();
    const expiresAt = new Date(executedAt.getTime() + 30 * 60_000);

    await insertRollbackRecord(db, {
      ...base,
      sessionId: 'rrr-full',
      beforeState: { content: 'old' },
      afterState: { content: 'hi' },
      diff: '-old\n+hi',
      rollbackAction: { tool: 'write_file', args: { path: 'notes.txt', content: 'old' } },
      expiresAt,
      executedAt,
    });

    const [row] = await db
      .select()
      .from(rollbackRecords)
      .where(eq(rollbackRecords.sessionId, 'rrr-full'));

    expect(row).toMatchObject({
      oxyUserId: OWNER,
      toolName: 'write_file',
      riskLevel: 'R1',
      status: 'open',
      args: { path: 'notes.txt', content: 'hi' },
      beforeState: { content: 'old' },
      afterState: { content: 'hi' },
      diff: '-old\n+hi',
      rollbackAction: { tool: 'write_file', args: { path: 'notes.txt', content: 'old' } },
    });
    // The window is a WINDOW: both instants survive as instants, and the
    // deadline is after the execution.
    expect(row?.executedAt).toBeInstanceOf(Date);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(row?.executedAt.getTime() ?? 0);
  });

  it('leaves an OMITTED optional column NULL rather than writing a placeholder', async () => {
    /**
     * `governance.ts` passes `beforeState`/`afterState`/`diff`/`rollbackAction`
     * through from its own optional parameters. All four columns are nullable,
     * so "the caller had nothing" and "the caller passed undefined" both land at
     * NULL today — the assertion pins that the write does not invent `{}` or
     * `''`, which would make an empty audit indistinguishable from a recorded
     * one.
     */
    await insertRollbackRecord(db, {
      ...base,
      sessionId: 'rrr-minimal',
      expiresAt: new Date(Date.now() + 60_000),
      executedAt: new Date(),
    });

    const [row] = await db
      .select()
      .from(rollbackRecords)
      .where(eq(rollbackRecords.sessionId, 'rrr-minimal'));

    expect(row).toMatchObject({
      beforeState: null,
      afterState: null,
      diff: null,
      rollbackAction: null,
      reason: null,
      rolledBackAt: null,
    });
    // The positive half: a row that DID carry them is stored non-null, so the
    // NULLs above are an omission rather than a column that never fills.
    const [full] = await db
      .select({ beforeState: rollbackRecords.beforeState })
      .from(rollbackRecords)
      .where(eq(rollbackRecords.sessionId, 'rrr-full'));
    expect(full?.beforeState).not.toBeNull();
  });

  it('accumulates one row per action, because two calls are two actions', async () => {
    await insertRollbackRecord(db, {
      ...base,
      sessionId: 'rrr-repeat',
      expiresAt: new Date(Date.now() + 60_000),
      executedAt: new Date(),
    });
    await insertRollbackRecord(db, {
      ...base,
      sessionId: 'rrr-repeat',
      expiresAt: new Date(Date.now() + 60_000),
      executedAt: new Date(),
    });

    const rows = await db
      .select({ id: rollbackRecords.id })
      .from(rollbackRecords)
      .where(eq(rollbackRecords.sessionId, 'rrr-repeat'));
    expect(rows.length).toBe(2);
  });

  it('closes the risk level, and R1 is the only value the source ever wrote', async () => {
    /**
     * `ROLLBACK_RISK_LEVELS` is the single-member tuple `['R1']`, and the CHECK
     * is what makes that a fact about the table rather than about one call site.
     * `classifyActionRisk` returns R0, R2 and R3 too — none of which opens a
     * rollback window — so an R2 landing here would mean the wrapper changed and
     * nobody noticed.
     */
    const bad = db.execute(sql`
      insert into ${rollbackRecords}
        (id, oxy_user_id, session_id, tool_name, risk_level, args, expires_at, executed_at)
      values ('rrr-bad', ${OWNER}, 'rrr-bad', 'sendEmail', 'R2', '{}'::jsonb, now(), now())
    `);
    await expect(bad).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('rollback_records_risk_level_check');
      return true;
    });
  });
});
