/**
 * The reviewed-action service: prepare → decide → re-bind → claim → run once.
 *
 * The repository, Oxy and the delivery are doubles; the hash, the binding
 * check and the state machine are real. The two guards this file pins are
 * mutation-checked (see the PR): dropping the live-hash comparison lets a
 * tampered or re-pointed action run, and dropping the claim lets a second
 * decision run it again — each turns a test here red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  agents: new Map<string, Record<string, unknown>>(),
  execute: vi.fn(),
  resolve: vi.fn(),
  postAgent: vi.fn(),
  postAlia: vi.fn(),
  postAliaTask: vi.fn(),
  ensureTask: vi.fn(),
  emit: vi.fn(),
  runApproved: vi.fn(),
  resolveInMemory: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async (_db: unknown, id: string) => H.agents.get(id) ?? null),
}));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => {
  const now = () => new Date();
  return {
    createAgentApprovalRequest: vi.fn(
      async (_db: unknown, input: Record<string, unknown> & { id: string }) => {
        for (const row of H.rows.values())
          if (row.turnId === input.turnId && row.actionHash === input.actionHash) return row;
        const row = { status: 'pending', ...input };
        H.rows.set(input.id, row);
        return row;
      },
    ),
    findAgentApproval: vi.fn(async (_db: unknown, id: string) => H.rows.get(id)),
    decideAgentApproval: vi.fn(
      async (
        _db: unknown,
        input: { approvalId: string; oxyUserId: string; approved: boolean; usableUntil?: Date },
      ) => {
        const row = H.rows.get(input.approvalId);
        if (!row || row.oxyUserId !== input.oxyUserId || row.status !== 'pending') return undefined;
        if ((row.expiresAt as Date) <= now()) return undefined;
        row.status = input.approved ? 'approved' : 'denied';
        if (input.approved && input.usableUntil) row.expiresAt = input.usableUntil;
        return { ...row };
      },
    ),
    claimApprovalExecution: vi.fn(async (_db: unknown, input: { approvalId: string }) => {
      const row = H.rows.get(input.approvalId);
      if (row?.status !== 'approved') return undefined;
      row.status = 'executing';
      return { ...row };
    }),
    finishApprovalExecution: vi.fn(
      async (_db: unknown, input: { approvalId: string; status: string }) => {
        const row = H.rows.get(input.approvalId);
        if (row?.status !== 'executing') return false;
        row.status = input.status;
        return true;
      },
    ),
    cancelApprovedAction: vi.fn(async (_db: unknown, input: { approvalId: string }) => {
      const row = H.rows.get(input.approvalId);
      if (row?.status !== 'approved') return false;
      row.status = 'cancelled';
      return true;
    }),
    markStuckApprovalExecutions: vi.fn(async () => {
      const stuck = [...H.rows.values()].filter((row) => row.status === 'executing');
      for (const row of stuck) row.status = 'outcome_unknown';
      return stuck;
    }),
  };
});
vi.mock('../../tools/oxy-services.js', () => ({ resolveReviewedOxyAction: H.resolve }));
vi.mock('../agent-outreach.js', () => ({ postAgentMessage: H.postAgent }));
vi.mock('../alia-outreach.js', () => ({
  postAliaConversationMessage: H.postAlia,
  postAliaMessage: H.postAliaTask,
  ensureAliaTaskConversation: H.ensureTask,
}));
vi.mock('../deferred-approvals.js', () => ({
  RERUN_APPROVAL_USABLE_FOR_MS: 86_400_000,
  runApprovedAction: H.runApproved,
}));
vi.mock('../action-approval.js', () => ({
  resolveApprovalDecision: H.resolveInMemory,
  sanitizeArgsForDisplay: (a: object) => a,
}));
vi.mock('../../../socket.js', () => ({
  getIO: () => ({ to: () => ({ emit: H.emit }) }),
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

import { proposalHash, type OxyActionProposal } from '../action-proposal.js';
import {
  decideReviewedAction,
  oxyApprovalGate,
  reapStuckReviewedActions,
} from '../action-review.js';

const PERSON = 'person-1';
const RESOURCE = {
  appId: 'social',
  effectiveAccountId: PERSON,
  resourceType: 'social_account',
  resourceId: PERSON,
};
const PROPOSAL: OxyActionProposal = {
  toolName: 'oxy_social__deletePost',
  appId: 'social',
  tool: 'deletePost',
  toolVersion: '1.0.0',
  kind: 'deletion',
  identity: 'for_user',
  resource: RESOURCE,
  args: { id: 'p1' },
};

function onlyRow(): Record<string, unknown> & { id: string } {
  const [row] = [...H.rows.values()];
  if (!row) throw new Error('no row filed');
  return row as Record<string, unknown> & { id: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.rows.clear();
  H.agents.clear();
  H.agents.set('agent-1', { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: PERSON });
  H.execute.mockResolvedValue({ status: 'succeeded', result: { deleted: true } });
  H.resolve.mockImplementation(async () => ({
    ok: true,
    toolVersion: '1.0.0',
    kind: 'deletion',
    execute: H.execute,
  }));
  H.ensureTask.mockResolvedValue('task-conv-1');
  H.postAliaTask.mockResolvedValue({ posted: true });
  H.postAgent.mockResolvedValue({ posted: true });
  H.postAlia.mockResolvedValue('msg-1');
});

async function filedByAlia(): Promise<string> {
  const gate = oxyApprovalGate({
    oxyUserId: PERSON,
    actor: { type: 'alia' },
    turnId: 'turn-1',
    delivery: { kind: 'present', conversationId: 'conv-1' },
  });
  return gate.propose(PROPOSAL);
}

async function approve(extra: { hash?: string; accessToken?: string | null } = {}) {
  const row = onlyRow();
  return decideReviewedAction({
    approvalId: row.id,
    deciderAccountId: PERSON,
    approved: true,
    ...(extra.hash ? { hash: extra.hash } : {}),
    ...(extra.accessToken === null ? {} : { accessToken: extra.accessToken ?? 'PERSON-TOKEN' }),
  });
}

describe('preparing', () => {
  it('files ONE direct row per exact action and turn, hashed over what makes it that action', async () => {
    const told = await filedByAlia();
    expect(told).toMatch(/Not done yet: this is a deletion/);
    expect(told).toMatch(/Do NOT call it again/);
    await filedByAlia();
    expect(H.rows.size).toBe(1);
    const row = onlyRow();
    expect(row).toMatchObject({
      actorType: 'alia',
      agentId: null,
      conversationId: 'conv-1',
      identityMode: 'for_user',
      executionMode: 'direct',
      oxyUserId: PERSON,
      actionHash: proposalHash({
        actor: { type: 'alia' },
        identity: 'for_user',
        tool: { appId: 'social', name: 'deletePost', version: '1.0.0' },
        input: { id: 'p1' },
        resource: RESOURCE,
      }),
    });
    // The person present sees it as a card; nothing is posted into the chat.
    expect(H.postAlia).not.toHaveBeenCalled();
    expect(H.emit).toHaveBeenCalledTimes(1);
    expect(H.execute).not.toHaveBeenCalled();
  });

  it("an Alia task asks in the task's own conversation; an agent in its thread", async () => {
    await oxyApprovalGate({
      oxyUserId: PERSON,
      actor: { type: 'alia' },
      turnId: 'run-7',
      delivery: {
        kind: 'alia_task',
        automationId: 'auto-1',
        objective: 'Tidy',
        conversationId: null,
      },
    }).propose(PROPOSAL);
    expect(onlyRow().conversationId).toBe('task-conv-1');
    expect(H.postAliaTask).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: 'auto-1',
        content: expect.stringMatching(/I need your OK/),
      }),
    );

    H.rows.clear();
    await oxyApprovalGate({
      oxyUserId: PERSON,
      actor: { type: 'agent', agentId: 'agent-1', accountId: 'bot-1' },
      turnId: 'sess-1',
      delivery: { kind: 'agent_thread', threadId: null },
    }).propose(PROPOSAL);
    expect(onlyRow()).toMatchObject({ actorType: 'agent', agentId: 'agent-1' });
    expect(H.postAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', title: 'Needs your approval' }),
    );
  });
});

describe('the hash names exactly one action', () => {
  const base = {
    actor: { type: 'alia' } as const,
    identity: 'for_user' as const,
    tool: { appId: 'social', name: 'deletePost', version: '1.0.0' },
    input: { id: 'p1', nested: { b: 1, a: 2 } },
    resource: RESOURCE,
  };
  it('is stable under key order and changes with every field', () => {
    const h = proposalHash(base);
    expect(proposalHash({ ...base, input: { nested: { a: 2, b: 1 }, id: 'p1' } })).toBe(h);
    for (const changed of [
      { ...base, actor: { type: 'agent', agentId: 'a', accountId: 'bot' } as const },
      { ...base, identity: 'self' as const },
      { ...base, tool: { ...base.tool, version: '2.0.0' } },
      { ...base, tool: { ...base.tool, name: 'trashPost' } },
      { ...base, input: { id: 'p2', nested: { b: 1, a: 2 } } },
      { ...base, resource: { ...RESOURCE, resourceId: 'other' } },
    ])
      expect(proposalHash(changed)).not.toBe(h);
  });
});

describe('deciding', () => {
  it('only the person it is for, and only with the hash they saw', async () => {
    await filedByAlia();
    const row = onlyRow();
    expect(
      await decideReviewedAction({
        approvalId: row.id,
        deciderAccountId: 'intruder',
        approved: true,
        accessToken: 'T',
      }),
    ).toEqual({ kind: 'not_found' });
    expect(await approve({ hash: 'stale-hash' })).toEqual({ kind: 'changed' });
    expect(await approve({ accessToken: null })).toEqual({ kind: 'needs_session' });
    expect(row.status).toBe('pending');
    expect(H.execute).not.toHaveBeenCalled();
  });

  it('cannot approve an expired request', async () => {
    await filedByAlia();
    onlyRow().expiresAt = new Date(Date.now() - 1);
    expect(await approve()).toEqual({ kind: 'not_found' });
    expect(H.execute).not.toHaveBeenCalled();
  });

  it('a denial runs nothing', async () => {
    await filedByAlia();
    const row = onlyRow();
    await expect(
      decideReviewedAction({ approvalId: row.id, deciderAccountId: PERSON, approved: false }),
    ).resolves.toMatchObject({ kind: 'decided', status: 'denied' });
    expect(H.resolve).not.toHaveBeenCalled();
    expect(H.execute).not.toHaveBeenCalled();
  });

  it('an approval performs it once, as the decider, and says so in the conversation', async () => {
    await filedByAlia();
    const row = onlyRow();
    await expect(approve({ hash: row.actionHash as string })).resolves.toMatchObject({
      kind: 'decided',
      status: 'succeeded',
    });
    expect(H.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'alia', ownerAccountId: PERSON },
        deciderAccountId: PERSON,
        userAccessToken: 'PERSON-TOKEN',
        operationId: row.id,
        resource: RESOURCE,
        args: { id: 'p1' },
      }),
    );
    expect(H.execute).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('succeeded');
    expect(H.postAlia).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        content: expect.stringMatching(/^Done/),
      }),
    );
  });

  it('a rerun approval starts the agent run and runs nothing here', async () => {
    H.rows.set('ap-r', {
      id: 'ap-r',
      oxyUserId: PERSON,
      status: 'pending',
      executionMode: 'rerun',
      actionHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
    });
    H.resolveInMemory.mockReturnValue(false);
    H.runApproved.mockResolvedValue({ started: true, sessionId: 'sess-9' });
    await expect(
      decideReviewedAction({ approvalId: 'ap-r', deciderAccountId: PERSON, approved: true }),
    ).resolves.toEqual({ kind: 'decided', status: 'approved', sessionId: 'sess-9' });
    expect(H.resolve).not.toHaveBeenCalled();
  });
});

describe('the binding is checked again before anything runs', () => {
  it('input changed after the person saw it: cancelled, never run', async () => {
    await filedByAlia();
    const row = onlyRow();
    (row.details as { args: Record<string, unknown> }).args = { id: 'someone-elses-post' };
    await expect(approve()).resolves.toMatchObject({ status: 'cancelled' });
    expect(H.execute).not.toHaveBeenCalled();
    expect(row.status).toBe('cancelled');
  });

  it('the catalog changed the tool since: cancelled, never run', async () => {
    await filedByAlia();
    H.resolve.mockResolvedValueOnce({
      ok: true,
      toolVersion: '2.0.0',
      kind: 'deletion',
      execute: H.execute,
    });
    await expect(approve()).resolves.toMatchObject({ status: 'cancelled' });
    expect(H.execute).not.toHaveBeenCalled();
  });

  it("an agent whose bot account changed, or that is no longer the decider's: cancelled", async () => {
    const file = () =>
      oxyApprovalGate({
        oxyUserId: PERSON,
        actor: { type: 'agent', agentId: 'agent-1', accountId: 'bot-1' },
        turnId: `sess-${Math.random()}`,
        delivery: { kind: 'agent_thread', threadId: null },
      }).propose(PROPOSAL);

    await file();
    H.agents.set('agent-1', { _id: 'agent-1', oxyAccountId: 'bot-2', ownerOxyAccountId: PERSON });
    await expect(approve()).resolves.toMatchObject({ status: 'cancelled' });

    H.rows.clear();
    await file();
    H.agents.set('agent-1', { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'other' });
    await expect(approve()).resolves.toMatchObject({ status: 'cancelled' });
    expect(H.execute).not.toHaveBeenCalled();
  });

  it('a binding Oxy no longer offers (a revoked level): cancelled', async () => {
    await filedByAlia();
    H.resolve.mockResolvedValueOnce({ ok: false, reason: 'binding_changed' });
    await expect(approve()).resolves.toMatchObject({
      status: 'cancelled',
      execution: { reason: 'binding_changed' },
    });
    expect(H.execute).not.toHaveBeenCalled();
  });
});

describe('never twice', () => {
  it('an action already claimed is not run by a second decision path', async () => {
    await filedByAlia();
    const row = onlyRow();
    // Somebody else won the claim between the decision and this execution.
    H.resolve.mockImplementationOnce(async () => {
      row.status = 'executing';
      return { ok: true, toolVersion: '1.0.0', kind: 'deletion', execute: H.execute };
    });
    await expect(approve()).resolves.toMatchObject({
      kind: 'decided',
      status: 'executing',
      execution: { status: 'not_claimed' },
    });
    expect(H.execute).not.toHaveBeenCalled();
  });

  it('a second approval of the same request does nothing', async () => {
    await filedByAlia();
    await approve();
    await expect(approve()).resolves.toEqual({ kind: 'not_found' });
    expect(H.execute).toHaveBeenCalledTimes(1);
  });

  it('a call sent with no answer ends outcome_unknown and is not retried', async () => {
    await filedByAlia();
    H.execute.mockResolvedValueOnce({ status: 'outcome_unknown', reason: 'no_answer' });
    await expect(approve()).resolves.toMatchObject({ status: 'outcome_unknown' });
    expect(onlyRow().status).toBe('outcome_unknown');
    expect(H.postAlia).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/could not confirm/) }),
    );
  });

  it('after a restart, an execution left running is outcome_unknown and the person is told', async () => {
    await filedByAlia();
    onlyRow().status = 'executing';
    expect(await reapStuckReviewedActions()).toBe(1);
    expect(onlyRow().status).toBe('outcome_unknown');
    expect(H.postAlia).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/interrupted/) }),
    );
  });
});
