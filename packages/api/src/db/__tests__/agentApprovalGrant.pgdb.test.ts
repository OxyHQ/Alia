import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  cancelApprovedAction,
  claimApprovalExecution,
  createAgentApprovalRequest,
  decideAgentApproval,
  expireAgentApprovals,
  findAgentApproval,
  findClaimedApprovalInTurn,
  findGrantedApproval,
  finishApprovalExecution,
  listPendingApprovals,
  markStuckApprovalExecutions,
} from '../agents/agentRuntimeRepository';

/**
 * A reviewed action's life, against a REAL server: filed (by an agent with no
 * thread, or by Alia herself), answered once before it expires, claimed
 * exactly once, ended, and — when its executor vanished — `outcome_unknown`.
 * The claim and the constraints only exist in Postgres, which is the point.
 */

let db: ApiDatabase;
const USER = `approval-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function file(actionHash: string) {
  return createAgentApprovalRequest(db, {
    id: randomUUID(),
    turnId: `turn-${randomUUID()}`,
    threadId: null,
    oxyUserId: USER,
    agentId: 'agent-1',
    toolName: 'send_message',
    riskLevel: 'R2',
    actionHash,
    summary: 'send it',
    details: { args: { to: 'a' } },
    expiresAt: new Date(Date.now() + 60_000),
  });
}

function fileFor(
  input: Partial<Parameters<typeof createAgentApprovalRequest>[1]> & { actionHash: string },
) {
  return createAgentApprovalRequest(db, {
    id: randomUUID(),
    turnId: `turn-${randomUUID()}`,
    threadId: null,
    oxyUserId: USER,
    agentId: 'agent-1',
    toolName: 'send_message',
    riskLevel: 'R2',
    summary: 'send it',
    details: { args: { to: 'a' } },
    expiresAt: new Date(Date.now() + 60_000),
    ...input,
  });
}

async function approved(actionHash: string) {
  const row = await file(actionHash);
  await decideAgentApproval(db, { approvalId: row.id, oxyUserId: USER, approved: true });
  return row;
}

describe('a deferred approval', () => {
  it('is filed without a thread, listed as pending, and granted only for its own action', async () => {
    const row = await file('hash-a');
    expect(row.threadId).toBeNull();
    expect(row.actorType).toBe('agent');
    expect(row.executionMode).toBe('rerun');
    expect((await listPendingApprovals(db, USER)).map((r) => r.id)).toContain(row.id);
    expect(
      await findGrantedApproval(db, { oxyUserId: USER, actionHash: 'hash-a' }),
    ).toBeUndefined();

    await decideAgentApproval(db, { approvalId: row.id, oxyUserId: USER, approved: true });
    expect(
      await findGrantedApproval(db, { oxyUserId: USER, actionHash: 'hash-other' }),
    ).toBeUndefined();
    expect(
      await findGrantedApproval(db, { oxyUserId: 'somebody-else', actionHash: 'hash-a' }),
    ).toBeUndefined();
    const grant = await findGrantedApproval(db, { oxyUserId: USER, actionHash: 'hash-a' });
    expect(grant?.id).toBe(row.id);
  });

  it('is claimed exactly once, even by two runs at the same time', async () => {
    const row = await approved('hash-b');

    const claims = await Promise.all([
      claimApprovalExecution(db, { approvalId: row.id, turnId: 'run-1' }),
      claimApprovalExecution(db, { approvalId: row.id, turnId: 'run-2' }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean);
    expect(winner?.status).toBe('executing');
    if (!winner?.executedByTurnId) throw new Error('the claim names no run');
    expect(
      await findGrantedApproval(db, { oxyUserId: USER, actionHash: 'hash-b' }),
    ).toBeUndefined();
    // The winner's run knows it already did this; the other run is not it.
    expect(
      (
        await findClaimedApprovalInTurn(db, {
          turnId: winner.executedByTurnId,
          actionHash: 'hash-b',
        })
      )?.id,
    ).toBe(row.id);

    expect(
      await finishApprovalExecution(db, { approvalId: row.id, status: 'succeeded', outcome: {} }),
    ).toBe(true);
    // Terminal: no second end, and no way back to a claimable state.
    expect(
      await finishApprovalExecution(db, { approvalId: row.id, status: 'failed', outcome: {} }),
    ).toBe(false);
    expect(
      await claimApprovalExecution(db, { approvalId: row.id, turnId: 'run-3' }),
    ).toBeUndefined();
    expect((await findAgentApproval(db, row.id))?.status).toBe('succeeded');
  });

  it('cannot be answered by somebody else', async () => {
    const row = await file('hash-c');
    expect(
      await decideAgentApproval(db, { approvalId: row.id, oxyUserId: 'intruder', approved: true }),
    ).toBeUndefined();
  });

  it('cannot be answered once expired, and an unclaimed approval expires too', async () => {
    const stale = await fileFor({ actionHash: 'hash-d', expiresAt: new Date(Date.now() - 1_000) });
    expect(
      await decideAgentApproval(db, { approvalId: stale.id, oxyUserId: USER, approved: true }),
    ).toBeUndefined();

    const row = await file('hash-e');
    await decideAgentApproval(db, {
      approvalId: row.id,
      oxyUserId: USER,
      approved: true,
      usableUntil: new Date(Date.now() - 1_000),
    });
    // Approved, but past its window: unclaimable, and the sweep closes it.
    expect(
      await claimApprovalExecution(db, { approvalId: row.id, turnId: 'late' }),
    ).toBeUndefined();
    const expired = await expireAgentApprovals(db);
    expect(expired).toEqual(expect.arrayContaining([stale.id, row.id]));
    expect((await findAgentApproval(db, row.id))?.status).toBe('expired');
  });

  it('an execution its executor never finished becomes outcome_unknown, never claimable', async () => {
    const row = await approved('hash-f');
    const claimedAt = new Date(Date.now() - 20 * 60_000);
    await claimApprovalExecution(db, { approvalId: row.id, turnId: 'lost' }, claimedAt);
    const fresh = await approved('hash-g');
    await claimApprovalExecution(db, { approvalId: fresh.id, turnId: 'alive' });

    const stuck = await markStuckApprovalExecutions(db, new Date(Date.now() - 15 * 60_000));
    const ids = stuck.map((r) => r.id);
    expect(ids).toContain(row.id);
    // One still running within its bound is left alone.
    expect(ids).not.toContain(fresh.id);
    const after = await findAgentApproval(db, row.id);
    expect(after?.status).toBe('outcome_unknown');
    expect(
      await claimApprovalExecution(db, { approvalId: row.id, turnId: 'retry' }),
    ).toBeUndefined();
    // Its late executor cannot overwrite the verdict either.
    expect(
      await finishApprovalExecution(db, { approvalId: row.id, status: 'succeeded', outcome: {} }),
    ).toBe(false);
  });

  it('an approval whose binding changed is cancelled and can never be claimed', async () => {
    const row = await approved('hash-h');
    expect(await cancelApprovedAction(db, { approvalId: row.id, outcome: { reason: 'x' } })).toBe(
      true,
    );
    expect(await claimApprovalExecution(db, { approvalId: row.id, turnId: 'any' })).toBeUndefined();
  });
});

describe('a request Alia files herself', () => {
  it('has no agent, belongs to a conversation and runs directly', async () => {
    const row = await fileFor({
      actionHash: 'hash-alia',
      actorType: 'alia',
      agentId: null,
      conversationId: 'conv-1',
      identityMode: 'for_user',
      executionMode: 'direct',
      resource: '{"appId":"mention"}',
    });
    expect(row).toMatchObject({
      actorType: 'alia',
      agentId: null,
      conversationId: 'conv-1',
      identityMode: 'for_user',
      executionMode: 'direct',
    });
  });

  it('the actor and its agent id agree, or Postgres refuses the row', async () => {
    await expect(
      fileFor({ actionHash: 'hash-bad-1', actorType: 'alia', agentId: 'agent-1' }),
    ).rejects.toThrow();
    await expect(
      fileFor({ actionHash: 'hash-bad-2', actorType: 'agent', agentId: null }),
    ).rejects.toThrow();
    await expect(
      fileFor({
        actionHash: 'hash-bad-3',
        identityMode: 'somebody' as 'self',
      }),
    ).rejects.toThrow();
  });
});
