import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ createTask: vi.fn(), revokeTask: vi.fn() }));
vi.mock('../oxy-service-client.js', () => ({ oxyServiceClient: () => ({ agency: authority }) }));
import { createOxyTask, revokeOxyTask } from '../oxy-task-authority.js';
beforeEach(() => {
  vi.resetAllMocks();
  authority.createTask.mockResolvedValue({
    id: 'task-1',
    requesterAccountId: 'requester',
    effectiveAccountId: 'requester',
  });
  authority.revokeTask.mockResolvedValue(undefined);
});
describe('original requester task authority', () => {
  it('binds a durable background goal to the requester and selected bot, never its owner', async () => {
    expect(
      await createOxyTask({
        accessToken: 'requester-session',
        requesterAccountId: 'requester',
        actorAccountId: 'bot-not-owned-by-requester',
        origin: { kind: 'goal', id: 'session-1' },
      }),
    ).toBe('task-1');
    const [terms, proof] = authority.createTask.mock.calls[0];
    expect(terms).toMatchObject({
      origin: { kind: 'goal', id: 'session-1' },
      actor: { type: 'agent', accountId: 'bot-not-owned-by-requester' },
      effectiveAccountId: 'requester',
    });
    expect(Date.parse(terms.expiresAt) - Date.now()).toBeGreaterThan(360 * 86400000);
    expect(proof).toEqual({ requesterToken: 'requester-session' });
    expect(terms).not.toHaveProperty('scopes');
  });
  it('keeps ephemeral requests inside the API lifetime and revokes on cancellation', async () => {
    await createOxyTask({
      accessToken: 'requester-session',
      requesterAccountId: 'requester',
      actor: { type: 'alia', ownerAccountId: 'requester' },
      origin: { kind: 'request', id: 'turn-1' },
    });
    expect(
      Date.parse(authority.createTask.mock.calls[0][0].expiresAt) - Date.now(),
    ).toBeLessThanOrEqual(10 * 60000);
    await revokeOxyTask('task-1');
    expect(authority.revokeTask).toHaveBeenCalledWith('task-1');
  });
  it('retires an unexpected account binding and refuses to store it', async () => {
    authority.createTask.mockResolvedValue({
      id: 'wrong-task',
      requesterAccountId: 'bot-owner',
      effectiveAccountId: 'bot-owner',
    });
    await expect(
      createOxyTask({
        accessToken: 'requester-session',
        requesterAccountId: 'requester',
        actorAccountId: 'bot',
        origin: { kind: 'goal', id: 'goal' },
      }),
    ).rejects.toThrow('originating account');
    expect(authority.revokeTask).toHaveBeenCalledWith('wrong-task');
  });
});
