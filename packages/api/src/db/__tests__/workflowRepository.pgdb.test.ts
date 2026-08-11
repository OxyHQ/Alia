import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  completeExecution,
  createExecution,
  createWorkflow,
  deleteExecutionsForWorkflow,
  deleteWorkflow,
  findExecutionOwner,
  findWorkflow,
  listExecutions,
  listWorkflows,
  updateWorkflow,
} from '../automation/workflowRepository';
import { workflowExecutions, workflows } from '../schema/automation';

/**
 * Canvas workflows and runs, against a real server.
 *
 * Owners and workflow ids are namespaced `wfr-*`: `workflow_id` carries a GLOBAL
 * unique, and the pgdb suite shares one database across files, so a colliding
 * fixture id here would fail another file rather than this one.
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

const seed = (owner: string, workflowId: string, name = 'a workflow') =>
  createWorkflow(db, {
    oxyUserId: owner,
    workflowId,
    name,
    description: '',
    nodes: [{ id: 'n1', type: 'prompt' }],
    edges: [],
  });

describe('the workflow lifecycle', () => {
  /**
   * The reason the `pre('save')` hook and the route's hand-set `updatedAt` could
   * BOTH go. Mongoose maintained the column two ways — the hook, which never
   * fired on `findOneAndUpdate`, and an explicit `updatedAt: new Date()` in the
   * update document. `@oxyhq/db`'s `updatedAt()` carries `$onUpdate`, so drizzle
   * writes it on every `db.update()`.
   *
   * Asserted as a strict INCREASE against the stored value: a column that was
   * never written and one written with the row's original timestamp are the same
   * observable to an equality check.
   */
  it('advances `updated_at` on update with nothing setting it by hand', async () => {
    const created = await seed('wfr-touch', 'wfr-touch-1');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await updateWorkflow(db, 'wfr-touch', 'wfr-touch-1', { name: 'renamed' });
    expect(updated?.name).toBe('renamed');
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    // `created_at` is insert-only and must NOT have moved with it.
    expect(updated?.createdAt).toEqual(created.createdAt);
  });

  it('leaves fields the patch omits alone', async () => {
    await seed('wfr-partial', 'wfr-partial-1', 'original');
    const updated = await updateWorkflow(db, 'wfr-partial', 'wfr-partial-1', {
      description: 'only this',
    });
    expect(updated?.description).toBe('only this');
    // The route spreads `req.body` in, so a PUT naming one field must not blank
    // the graph. This is the assertion that fails if the omission stops working.
    expect(updated?.name).toBe('original');
    expect(updated?.nodes).toEqual([{ id: 'n1', type: 'prompt' }]);
  });

  it('scopes every addressed operation by owner', async () => {
    await seed('wfr-owner', 'wfr-owner-1');

    expect(await findWorkflow(db, 'wfr-owner', 'wfr-owner-1')).toBeDefined();
    // Negative half: the same id, a different account.
    expect(await findWorkflow(db, 'wfr-intruder', 'wfr-owner-1')).toBeUndefined();
    expect(await updateWorkflow(db, 'wfr-intruder', 'wfr-owner-1', { name: 'x' })).toBeUndefined();
    expect(await deleteWorkflow(db, 'wfr-intruder', 'wfr-owner-1')).toBeUndefined();

    // And the row the intruder could not touch is untouched.
    const survived = await findWorkflow(db, 'wfr-owner', 'wfr-owner-1');
    expect(survived?.name).toBe('a workflow');
  });

  it('lists a user own workflows, most recently updated first', async () => {
    await seed('wfr-list', 'wfr-list-1', 'first');
    await seed('wfr-list', 'wfr-list-2', 'second');
    await seed('wfr-other', 'wfr-list-3', 'not mine');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateWorkflow(db, 'wfr-list', 'wfr-list-1', { name: 'first, touched' });

    const rows = await listWorkflows(db, 'wfr-list');
    expect(rows.map((r) => r.workflowId)).toEqual(['wfr-list-1', 'wfr-list-2']);
  });

  it('deletes the workflow and, separately, its runs', async () => {
    await seed('wfr-del', 'wfr-del-1');
    await createExecution(db, {
      oxyUserId: 'wfr-del',
      workflowId: 'wfr-del-1',
      executionId: 'wfr-del-exec-1',
      startedAt: new Date(),
    });

    expect(await deleteWorkflow(db, 'wfr-del', 'wfr-del-1')).toBeDefined();
    /**
     * The run OUTLIVES its workflow until the handler removes it. There is no
     * foreign key here by design, so deleting the parent alone leaves the child,
     * and a reader inferring "no workflow means no runs" would be wrong.
     */
    expect(
      await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.executionId, 'wfr-del-exec-1')),
    ).toHaveLength(1);

    await deleteExecutionsForWorkflow(db, 'wfr-del-1');
    expect(
      await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.executionId, 'wfr-del-exec-1')),
    ).toHaveLength(0);
  });
});

describe('a run', () => {
  it('opens on the column defaults the source set by hand', async () => {
    const row = await createExecution(db, {
      oxyUserId: 'wfr-run',
      workflowId: 'wfr-run-1',
      executionId: 'wfr-run-exec-1',
      startedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(row.status).toBe('running');
    expect(row.results).toEqual([]);
    expect(row.finalOutput).toBe('');
    expect(row.completedAt).toBeNull();
  });

  it('closes as completed, carrying its results', async () => {
    await createExecution(db, {
      oxyUserId: 'wfr-run',
      workflowId: 'wfr-run-2',
      executionId: 'wfr-run-exec-2',
      startedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await completeExecution(db, 'wfr-run-exec-2', {
      status: 'completed',
      results: [{ nodeId: 'n1', output: 'ok' }],
      finalOutput: 'done',
      completedAt: new Date('2026-03-01T00:01:00.000Z'),
    });

    const [row] = await listExecutions(db, 'wfr-run', 'wfr-run-2');
    expect(row?.status).toBe('completed');
    expect(row?.results).toEqual([{ nodeId: 'n1', output: 'ok' }]);
    expect(row?.finalOutput).toBe('done');
    expect(row?.completedAt).toEqual(new Date('2026-03-01T00:01:00.000Z'));
  });

  it('closes as failed without disturbing what the run accumulated', async () => {
    await createExecution(db, {
      oxyUserId: 'wfr-run',
      workflowId: 'wfr-run-3',
      executionId: 'wfr-run-exec-3',
      startedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await completeExecution(db, 'wfr-run-exec-3', {
      status: 'completed',
      results: [{ nodeId: 'n1', output: 'partial' }],
      finalOutput: '',
      completedAt: new Date('2026-03-01T00:00:30.000Z'),
    });
    // The failure path names no `results`, so the partial output must survive.
    await completeExecution(db, 'wfr-run-exec-3', {
      status: 'failed',
      finalOutput: 'boom',
      completedAt: new Date('2026-03-01T00:01:00.000Z'),
    });

    const [row] = await listExecutions(db, 'wfr-run', 'wfr-run-3');
    expect(row?.status).toBe('failed');
    expect(row?.finalOutput).toBe('boom');
    expect(row?.results).toEqual([{ nodeId: 'n1', output: 'partial' }]);
  });

  it('refuses a status outside the closed set', async () => {
    await expect(
      db.insert(workflowExecutions).values({
        oxyUserId: 'wfr-check',
        workflowId: 'wfr-check-1',
        executionId: 'wfr-check-exec-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probing the CHECK
        status: 'cancelled' as any,
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('lists a workflow runs newest first, scoped to the owner', async () => {
    for (const [n, day] of [
      ['a', '2026-03-01'],
      ['b', '2026-03-03'],
      ['c', '2026-03-02'],
    ] as const) {
      await createExecution(db, {
        oxyUserId: 'wfr-hist',
        workflowId: 'wfr-hist-1',
        executionId: `wfr-hist-exec-${n}`,
        startedAt: new Date(`${day}T00:00:00.000Z`),
      });
    }
    await createExecution(db, {
      oxyUserId: 'wfr-hist-other',
      workflowId: 'wfr-hist-1',
      executionId: 'wfr-hist-exec-other',
      startedAt: new Date('2026-03-04T00:00:00.000Z'),
    });

    const rows = await listExecutions(db, 'wfr-hist', 'wfr-hist-1');
    expect(rows.map((r) => r.executionId)).toEqual([
      'wfr-hist-exec-b',
      'wfr-hist-exec-c',
      'wfr-hist-exec-a',
    ]);
  });
});

describe('the socket room access check', () => {
  it('answers the owner, and undefined for a run that does not exist', async () => {
    await createExecution(db, {
      oxyUserId: 'wfr-sock',
      workflowId: 'wfr-sock-1',
      executionId: 'wfr-sock-exec-1',
      startedAt: new Date(),
    });

    expect(await findExecutionOwner(db, 'wfr-sock-exec-1')).toBe('wfr-sock');
    /**
     * The negative half is the security-relevant one: an unknown execution id
     * must not answer with something a caller could match. `undefined` never
     * equals the socket's `userId`, so the join is refused.
     */
    expect(await findExecutionOwner(db, 'wfr-sock-does-not-exist')).toBeUndefined();
  });
});

describe('the caller-supplied workflow id', () => {
  it('is globally unique, so a second workflow cannot claim it', async () => {
    await seed('wfr-uniq', 'wfr-uniq-1');
    await expect(seed('wfr-uniq-other', 'wfr-uniq-1')).rejects.toThrow();
    // Positive control: the constraint is on the id, not on inserting at all.
    await expect(seed('wfr-uniq-other', 'wfr-uniq-2')).resolves.toBeDefined();
  });

  it('is likewise unique across runs', async () => {
    await createExecution(db, {
      oxyUserId: 'wfr-uniq2',
      workflowId: 'wfr-uniq2-1',
      executionId: 'wfr-uniq2-exec-1',
      startedAt: new Date(),
    });
    await expect(
      createExecution(db, {
        oxyUserId: 'wfr-uniq2',
        workflowId: 'wfr-uniq2-1',
        executionId: 'wfr-uniq2-exec-1',
        startedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('workflow rows are not visible across accounts', () => {
  it('counts only this file own fixtures', async () => {
    // Scoped to an owner this file owns: the pgdb suite shares one database, so
    // an unscoped count would report another file's rows and drift.
    const mine = await db.select().from(workflows).where(eq(workflows.oxyUserId, 'wfr-list'));
    expect(mine).toHaveLength(2);
  });
});
