import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createAgentApprovalRequest,
  decideAgentApproval,
  findGrantedApproval,
  listPendingApprovals,
  markApprovalExecuted,
} from '../agents/agentRuntimeRepository';

/**
 * A deferred approval's life, against a REAL server: filed with no thread (a
 * background run), answered, spent exactly once.
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

describe('a deferred approval', () => {
  it('is filed without a thread, listed as pending, and granted only for its own action', async () => {
    const row = await file('hash-a');
    expect(row.threadId).toBeNull();
    expect((await listPendingApprovals(db, USER)).map((r) => r.id)).toContain(row.id);

    const since = new Date(Date.now() - 60_000);
    expect(await findGrantedApproval(db, { oxyUserId: USER, agentId: 'agent-1', actionHash: 'hash-a', decidedAfter: since })).toBeUndefined();

    await decideAgentApproval(db, { approvalId: row.id, oxyUserId: USER, approved: true });
    expect(await findGrantedApproval(db, { oxyUserId: USER, agentId: 'agent-1', actionHash: 'hash-other', decidedAfter: since })).toBeUndefined();
    const grant = await findGrantedApproval(db, { oxyUserId: USER, agentId: 'agent-1', actionHash: 'hash-a', decidedAfter: since });
    expect(grant?.id).toBe(row.id);
  });

  it('is spent exactly once, even by two runs at the same time', async () => {
    const row = await file('hash-b');
    await decideAgentApproval(db, { approvalId: row.id, oxyUserId: USER, approved: true });

    const spent = await Promise.all([markApprovalExecuted(db, row.id), markApprovalExecuted(db, row.id)]);
    expect(spent.filter(Boolean)).toHaveLength(1);
    const since = new Date(Date.now() - 60_000);
    expect(await findGrantedApproval(db, { oxyUserId: USER, agentId: 'agent-1', actionHash: 'hash-b', decidedAfter: since })).toBeUndefined();
  });

  it('cannot be answered by somebody else', async () => {
    const row = await file('hash-c');
    expect(await decideAgentApproval(db, { approvalId: row.id, oxyUserId: 'intruder', approved: true })).toBeUndefined();
  });
});
