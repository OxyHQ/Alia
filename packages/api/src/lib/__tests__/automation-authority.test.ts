import { beforeEach, describe, expect, it, vi } from 'vitest';

const authority = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('../oxy-capability-authority.js', () => ({
  createOxyExecutionAuthorization: authority.create,
  revokeOxyExecutionAuthorization: authority.revoke,
}));

import {
  provisionAliaTaskAuthorizations,
  provisionAutomationAuthorizations,
  revokeAutomationAuthorizations,
} from '../automation-authority.js';

const resource = {
  appId: 'inbox',
  effectiveAccountId: 'account-1',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};

beforeEach(() => {
  authority.create.mockReset();
  authority.revoke.mockReset().mockResolvedValue(undefined);
});

describe('durable automation authority', () => {
  it('creates one exact Oxy authorization per action and eligible agent', async () => {
    authority.create
      .mockResolvedValueOnce('authorization-1')
      .mockResolvedValueOnce('authorization-2');

    const result = await provisionAutomationAuthorizations({
      accessToken: 'user-token',
      ownerAccountId: 'account-1',
      automationId: 'automation-1',
      maximumAutonomy: 'autonomous',
      pairs: [
        {
          agent: { agentId: 'agent-1', actorAccountId: 'bot-1' },
          action: { id: 'action-1', resource, tool: 'sendEmail', limits: [{ key: 'daily', value: 5 }] },
        },
        {
          agent: { agentId: 'agent-2', actorAccountId: 'bot-2' },
          action: { id: 'action-1', resource, tool: 'sendEmail', limits: [{ key: 'daily', value: 5 }] },
        },
      ],
    });

    expect(result.map((entry) => entry.oxyAuthorizationId)).toEqual([
      'authorization-1',
      'authorization-2',
    ]);
    expect(authority.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accessToken: 'user-token',
      kind: 'automation',
      automationId: 'automation-1',
      actor: { type: 'agent', accountId: 'bot-1' },
      resource,
      tool: 'sendEmail',
      limits: [{ tool: 'sendEmail', key: 'daily', value: 5 }],
    }));
  });

  it('revokes every successful sibling when one authorization fails', async () => {
    authority.create
      .mockResolvedValueOnce('authorization-1')
      .mockRejectedValueOnce(new Error('policy denied'));

    await expect(provisionAutomationAuthorizations({
      accessToken: 'user-token',
      ownerAccountId: 'account-1',
      automationId: 'automation-1',
      maximumAutonomy: 'autonomous',
      pairs: [
        {
          agent: { agentId: 'agent-1', actorAccountId: 'bot-1' },
          action: { id: 'action-1', resource, tool: 'searchEmails', limits: [] },
        },
        {
          agent: { agentId: 'agent-1', actorAccountId: 'bot-1' },
          action: { id: 'action-2', resource, tool: 'sendEmail', limits: [] },
        },
      ],
    })).rejects.toThrow('policy denied');

    expect(authority.revoke).toHaveBeenCalledWith('user-token', 'authorization-1');
  });

  it('reports partial revocation without hiding the failed ids', async () => {
    authority.revoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network'));
    await expect(revokeAutomationAuthorizations('user-token', ['a', 'b', 'a'])).resolves.toEqual({
      revoked: ['a'],
      failed: ['b'],
    });
  });

  describe('Alia\'s standing authority for her own task', () => {
    const root = { appId: 'inbox', effectiveAccountId: 'account-1', resourceType: 'email_account', resourceId: 'account-1' };
    const action = { id: 'action-1', resource, tool: 'sendEmail', limits: [{ key: 'daily', value: 5 }] };

    it('authorizes Alia as the actor: declared actions at the task autonomy, reads read-only', async () => {
      authority.create.mockImplementation(async (input: { tool: string }) => `oxy-${input.tool}`);

      const result = await provisionAliaTaskAuthorizations({
        accessToken: 'user-token',
        ownerAccountId: 'account-1',
        automationId: 'automation-1',
        maximumAutonomy: 'autonomous',
        actions: [action],
        // The same tool as the action is covered by the action, not twice.
        reads: [{ resource: root, tool: 'listEmails' }, { resource, tool: 'sendEmail' }],
      });

      expect(authority.create).toHaveBeenCalledTimes(2);
      expect(authority.create).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'automation',
        automationId: 'automation-1',
        actor: { type: 'alia', ownerAccountId: 'account-1' },
        resource,
        tool: 'sendEmail',
        maximumAutonomy: 'autonomous',
        limits: [{ tool: 'sendEmail', key: 'daily', value: 5 }],
      }));
      expect(authority.create).toHaveBeenCalledWith(expect.objectContaining({
        actor: { type: 'alia', ownerAccountId: 'account-1' },
        resource: root,
        tool: 'listEmails',
        maximumAutonomy: 'read_only',
        limits: [],
      }));
      // Never a run or step: Oxy takes those when each ticket is issued.
      expect(authority.create.mock.calls.every(([input]) => !('runId' in input) && !('stepId' in input))).toBe(true);
      expect(result).toEqual({
        provisioned: [
          expect.objectContaining({ automationActionId: 'action-1', tool: 'sendEmail', oxyAuthorizationId: 'oxy-sendEmail' }),
          expect.objectContaining({ automationActionId: null, tool: 'listEmails', oxyAuthorizationId: 'oxy-listEmails' }),
        ],
        refusedReads: 0,
      });
    });

    it('keeps the task when Oxy refuses a read, and counts it', async () => {
      authority.create
        .mockResolvedValueOnce('oxy-read-1')
        .mockRejectedValueOnce(new Error('tool_not_available_for_resource'));

      const result = await provisionAliaTaskAuthorizations({
        accessToken: 'user-token',
        ownerAccountId: 'account-1',
        automationId: 'automation-1',
        maximumAutonomy: 'autonomous',
        actions: [],
        reads: [{ resource: root, tool: 'listEmails' }, { resource: root, tool: 'getEmail' }],
      });
      expect(result.provisioned).toHaveLength(1);
      expect(result.refusedReads).toBe(1);
      expect(authority.revoke).not.toHaveBeenCalled();
    });

    it('is all-or-nothing for declared actions', async () => {
      authority.create
        .mockRejectedValueOnce(new Error('policy denied'))
        .mockResolvedValueOnce('oxy-read-1');

      await expect(provisionAliaTaskAuthorizations({
        accessToken: 'user-token',
        ownerAccountId: 'account-1',
        automationId: 'automation-1',
        maximumAutonomy: 'autonomous',
        actions: [action],
        reads: [{ resource: root, tool: 'listEmails' }],
      })).rejects.toThrow('policy denied');
      expect(authority.revoke).toHaveBeenCalledWith('user-token', 'oxy-read-1');
    });
  });
});
