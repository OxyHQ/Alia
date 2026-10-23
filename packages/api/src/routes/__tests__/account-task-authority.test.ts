import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  find: vi.fn(),
  save: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  findConnectedAccountForUser: fixture.find,
  setConnectedAccountTask: fixture.save,
}));
vi.mock('../../lib/oxy-task-authority.js', () => ({
  createOxyTask: fixture.create,
  revokeOxyTask: fixture.revoke,
}));
vi.mock('../../lib/integrations-client.js', () => ({ integrationsFetch: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ log: { channels: { warn: vi.fn(), error: vi.fn() } } }));
import router from '../accounts.js';
const handler = (router as any).stack
  .find((entry: any) => entry.route?.path === '/:id/reauthorize')
  .route.stack.at(-1).handle;
function res() {
  const value: any = {};
  value.status = vi.fn(() => value);
  value.json = vi.fn(() => value);
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.find.mockResolvedValue({
    id: 'connection',
    oxyTaskId: 'old-task',
    oxyTaskState: 'active',
  });
  fixture.save.mockResolvedValue(true);
  fixture.create.mockResolvedValue('new-task');
  fixture.revoke.mockResolvedValue(undefined);
});
describe('connected account task renewal', () => {
  it('binds a durable automation to the verified account and original requester proof', async () => {
    const response = res();
    await handler(
      {
        params: { id: 'connection' },
        userId: 'managed-account',
        accessToken: 'requester-proof',
        body: { oxyUserId: 'forged' },
      },
      response,
    );
    expect(fixture.find).toHaveBeenCalledWith({}, 'connection', 'managed-account');
    expect(fixture.revoke).toHaveBeenCalledWith('old-task');
    expect(fixture.create).toHaveBeenCalledWith({
      effectiveAccountId: 'managed-account',
      accessToken: 'requester-proof',
      actor: { type: 'alia', ownerAccountId: 'managed-account' },
      origin: { kind: 'automation', id: 'channel:connection' },
    });
    expect(response.json).toHaveBeenCalledWith({ success: true, oxyTaskState: 'active' });
  });
  it('cannot renew another account connection', async () => {
    fixture.find.mockResolvedValue(null);
    const response = res();
    await handler({ params: { id: 'other' }, userId: 'person', accessToken: 'proof' }, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.revoke).not.toHaveBeenCalled();
  });
  it('cannot create a requester task without a real foreground proof', async () => {
    const response = res();
    await handler({ params: { id: 'connection' }, userId: 'person' }, response);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it('revokes a losing concurrent task instead of leaving an untracked root', async () => {
    fixture.save.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = res();
    await handler(
      { params: { id: 'connection' }, userId: 'person', accessToken: 'proof' },
      response,
    );
    expect(fixture.revoke).toHaveBeenCalledWith('new-task');
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
