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
      agents: [
        { agentId: 'agent-1', actorAccountId: 'bot-1' },
        { agentId: 'agent-2', actorAccountId: 'bot-2' },
      ],
      actions: [{ id: 'action-1', resource, tool: 'sendEmail', limits: [{ key: 'daily', value: 5 }] }],
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
      agents: [{ agentId: 'agent-1', actorAccountId: 'bot-1' }],
      actions: [
        { id: 'action-1', resource, tool: 'searchEmails', limits: [] },
        { id: 'action-2', resource, tool: 'sendEmail', limits: [] },
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
});
