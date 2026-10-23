import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  findLinked: vi.fn(),
  replace: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'selected-account' } as typeof req.user;
    req.userId = 'selected-account';
    req.accessToken = 'verified-session';
    if (req.header('x-fixture-service')) req.serviceApp = {} as typeof req.serviceApp;
    next();
  },
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/botRepository.js', () => ({
  findBotById: async () => ({ id: 'bot-1', status: 'active', userId: 'different-bot-owner' }),
  findLinkedBotUser: state.findLinked,
  replaceBotUserTask: state.replace,
}));
vi.mock('../../lib/oxy-task-authority.js', () => ({
  createOxyTask: state.create,
  revokeOxyTask: state.revoke,
}));
import botsRouter from '../bots.js';
let server: Server;
let origin: string;
beforeEach(async () => {
  vi.resetAllMocks();
  state.findLinked.mockResolvedValue({
    id: 'link-1',
    oxyTaskId: null,
    oxyTaskState: 'reauth_required',
  });
  state.replace.mockResolvedValue(true);
  state.create.mockResolvedValue('root-new');
  state.revoke.mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use('/bots', botsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function renew(headers: Record<string, string> = {}) {
  return fetch(`${origin}/bots/bot-1/reauthorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ accountId: 'different-bot-owner', taskId: 'forged' }),
  });
}
describe('existing channel task renewal', () => {
  it('uses the selected account and live session, ignoring owner/task ids in the body', async () => {
    expect((await renew()).status).toBe(200);
    expect(state.findLinked).toHaveBeenCalledWith({}, 'bot-1', 'selected-account');
    expect(state.create).toHaveBeenCalledWith({
      accessToken: 'verified-session',
      effectiveAccountId: 'selected-account',
      actor: { type: 'alia', ownerAccountId: 'selected-account' },
      origin: { kind: 'automation', id: 'channel:link-1' },
    });
    expect(state.replace).toHaveBeenCalledWith({}, 'link-1', 'selected-account', null, 'root-new');
  });
  it('does not renew another account or a service credential', async () => {
    state.findLinked.mockResolvedValue(null);
    expect((await renew()).status).toBe(404);
    expect((await renew({ 'x-fixture-service': 'yes' })).status).toBe(401);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('retires the uncommitted root if the channel changes during validation', async () => {
    state.replace.mockResolvedValue(false);
    expect((await renew()).status).toBe(503);
    expect(state.revoke).toHaveBeenCalledWith('root-new');
  });
  it('does not rotate a live root merely because the account was viewed again', async () => {
    state.findLinked.mockResolvedValue({
      id: 'link-1',
      oxyTaskId: 'existing',
      oxyTaskState: 'active',
    });
    expect((await renew()).status).toBe(200);
    expect(state.create).not.toHaveBeenCalled();
  });
});
