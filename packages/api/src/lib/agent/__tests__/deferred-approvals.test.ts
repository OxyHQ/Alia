import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  create: vi.fn(),
  find: vi.fn(),
  granted: vi.fn(),
  spend: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  reserve: vi.fn(),
  refund: vi.fn(),
  enqueue: vi.fn(),
  post: vi.fn(),
  claimedInTurn: vi.fn(),
  finish: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({
  createAgentApprovalRequest: H.create,
  findAgentApproval: H.find,
  findGrantedApproval: H.granted,
  findClaimedApprovalInTurn: H.claimedInTurn,
  claimApprovalExecution: H.spend,
  finishApprovalExecution: H.finish,
}));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: H.createSession,
  updateAgentSession: H.updateSession,
}));
vi.mock('../../credits-manager.js', () => ({ reserveCredits: H.reserve, safeRefund: H.refund }));
vi.mock('../../task-queue.js', () => ({ enqueueAgentSession: H.enqueue }));
vi.mock('../../user-credits-helpers.js', () => ({
  getOrCreateUserCredits: vi.fn(async () => undefined),
}));
vi.mock('../agent-outreach.js', () => ({ postAgentMessage: H.post }));
vi.mock('../action-approval.js', () => ({ sanitizeArgsForDisplay: (a: object) => a }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import {
  deferredActionHash,
  deferredApprovalsFor,
  runApprovedAction,
} from '../deferred-approvals.js';

const SESSION = { _id: 'sess-1', oxyUserId: 'u', agentId: 'agent-1', threadId: null } as never;
const HOLD = { oxyUserId: 'u', creditsReserved: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  H.post.mockResolvedValue({ posted: true });
  H.reserve.mockResolvedValue(HOLD);
});

describe('deferred approvals', () => {
  it('hashes the same call the same way whatever the key order', () => {
    expect(deferredActionHash('a', 'u', 't', { x: 1, y: { b: 2, a: 1 } })).toBe(
      deferredActionHash('a', 'u', 't', { y: { a: 1, b: 2 }, x: 1 }),
    );
    expect(deferredActionHash('a', 'u', 't', { x: 1 })).not.toBe(
      deferredActionHash('a', 'u', 't', { x: 2 }),
    );
  });

  it('binds the hash to the agent AND the person: neither can borrow the other’s approval', () => {
    const base = deferredActionHash('a', 'u', 't', { x: 1 });
    expect(deferredActionHash('b', 'u', 't', { x: 1 })).not.toBe(base);
    expect(deferredActionHash('a', 'v', 't', { x: 1 })).not.toBe(base);
  });

  it('files a request and tells the person once, not on every retry', async () => {
    H.create.mockImplementation(async (_db: unknown, input: { id: string }) => ({
      ...input,
      status: 'pending',
    }));
    const approvals = deferredApprovalsFor(SESSION);

    const told = await approvals.request('send_message', { to: 'a' }, 'reason');
    expect(told).toMatch(/needs the person's approval/);
    expect(H.post).toHaveBeenCalledTimes(1);
    expect(H.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: null,
        details: expect.objectContaining({ args: { to: 'a' } }),
      }),
    );

    // The same call again finds the row it already filed.
    H.create.mockResolvedValueOnce({ id: 'existing', status: 'pending' });
    await approvals.request('send_message', { to: 'a' }, 'reason');
    expect(H.post).toHaveBeenCalledTimes(1);
  });

  it('claims a grant for exactly this call, once, and records how it ended', async () => {
    H.claimedInTurn.mockResolvedValue(undefined);
    H.granted.mockResolvedValue({ id: 'grant-1' });
    H.spend.mockResolvedValue({ id: 'grant-1', status: 'executing' });
    H.finish.mockResolvedValue(true);

    const grant = await deferredApprovalsFor(SESSION).granted('send_message', { to: 'a' });
    expect(grant.state).toBe('claimed');
    expect(H.granted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionHash: deferredActionHash('agent-1', 'u', 'send_message', { to: 'a' }),
      }),
    );
    expect(H.spend).toHaveBeenCalledWith(expect.anything(), {
      approvalId: 'grant-1',
      turnId: 'sess-1',
    });
    if (grant.state !== 'claimed') throw new Error('unreachable');
    await grant.finish('succeeded', {});
    expect(H.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvalId: 'grant-1', status: 'succeeded' }),
    );
  });

  it('never runs a grant another run already claimed', async () => {
    H.claimedInTurn.mockResolvedValue(undefined);
    H.granted.mockResolvedValue({ id: 'grant-1' });
    H.spend.mockResolvedValue(undefined);
    await expect(
      deferredApprovalsFor(SESSION).granted('send_message', { to: 'a' }),
    ).resolves.toEqual({ state: 'already_done' });
  });

  it('never asks again for what this run already did under an approval', async () => {
    H.claimedInTurn.mockResolvedValue({ id: 'grant-1', status: 'succeeded' });
    await expect(
      deferredApprovalsFor(SESSION).granted('send_message', { to: 'a' }),
    ).resolves.toEqual({ state: 'already_done' });
    expect(H.granted).not.toHaveBeenCalled();
  });

  it('starts a held, queued run for an approved action, with its exact arguments', async () => {
    H.find.mockResolvedValue({
      id: 'ap-1',
      status: 'approved',
      executionMode: 'rerun',
      oxyUserId: 'u',
      agentId: 'agent-1',
      threadId: 'th-1',
      toolName: 'send_message',
      summary: 'send it',
      details: { args: { to: 'a' } },
    });
    H.createSession.mockResolvedValue({ _id: 'sess-2' });
    H.enqueue.mockResolvedValue({ queued: true });

    await expect(runApprovedAction('ap-1')).resolves.toEqual({
      started: true,
      sessionId: 'sess-2',
    });
    expect(H.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-1',
        oxyUserId: 'u',
        threadId: 'th-1',
        creditReservation: HOLD,
        task: expect.stringContaining('{"to":"a"}'),
      }),
    );
  });

  it('starts no run for an Oxy action: the decision itself performs those', async () => {
    H.find.mockResolvedValue({
      id: 'ap-1',
      status: 'approved',
      executionMode: 'direct',
      oxyUserId: 'u',
      agentId: 'agent-1',
      details: { args: {} },
    });
    await expect(runApprovedAction('ap-1')).resolves.toEqual({ started: false });
    expect(H.createSession).not.toHaveBeenCalled();
  });

  it('gives the hold back when the run cannot be queued', async () => {
    H.find.mockResolvedValue({
      id: 'ap-1',
      status: 'approved',
      executionMode: 'rerun',
      oxyUserId: 'u',
      agentId: 'agent-1',
      threadId: null,
      toolName: 'send_message',
      summary: 's',
      details: { args: {} },
    });
    H.createSession.mockResolvedValue({ _id: 'sess-3' });
    H.enqueue.mockRejectedValue(new Error('redis down'));
    H.updateSession.mockResolvedValue(1);

    await expect(runApprovedAction('ap-1')).resolves.toEqual({ started: false });
    expect(H.refund).toHaveBeenCalledWith(HOLD, expect.any(String));
    expect(H.updateSession).toHaveBeenCalledWith(
      expect.anything(),
      'sess-3',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
