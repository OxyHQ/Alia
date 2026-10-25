import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALIA_APPLICATION_ID, ALIA_INTEGRATIONS_WORKLOAD_ID } from '@alia.onl/server/internal';
const fixture = vi.hoisted(() => ({
  principal: undefined as any,
  bot: vi.fn(),
  link: vi.fn(),
  connection: vi.fn(),
}));
vi.mock('../../lib/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    middleware: {
      service: () => async (req: any, res: any, next: () => void) => {
        if (req.headers.authorization !== 'Bearer workload') {
          res.status(401).json({ error: 'invalid' });
          return;
        }
        req.serviceApp = fixture.principal;
        next();
      },
    },
  }),
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/botRepository.js', () => ({
  findSystemBot: fixture.bot,
  findBotUser: fixture.link,
}));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  findConnectedAccountBySession: fixture.connection,
}));
import { authenticateChannelAccount, authenticateChannelBot } from '../channel-auth.js';
const ACCOUNT = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';
function response() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}
async function invoke(headers: Record<string, string | undefined>) {
  const req: any = { headers: { authorization: 'Bearer workload', ...headers } };
  const res = response();
  const next = vi.fn();
  await authenticateChannelAccount(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { req, res, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.principal = {
    authority: 'first_party',
    appId: ALIA_APPLICATION_ID,
    credentialId: ALIA_INTEGRATIONS_WORKLOAD_ID,
  };
  fixture.bot.mockResolvedValue({ id: 'bot', status: 'active' });
  fixture.link.mockResolvedValue({
    id: 'link',
    oxyUserId: ACCOUNT,
    isLinked: true,
    oxyTaskState: 'active',
    oxyTaskId: 'task',
  });
  fixture.connection.mockResolvedValue({
    id: 'connection',
    oxyUserId: ACCOUNT,
    oxyTaskState: 'active',
    oxyTaskId: 'task',
  });
});
describe('channel workload identity', () => {
  it('resolves bot-linked account and task without creating an Oxy session', async () => {
    const { req, next } = await invoke({
      'x-alia-channel': 'telegram',
      'x-alia-platform-user': '123',
      'x-alia-account-context': 'forged',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe(ACCOUNT);
    expect(req.channelContext.taskId).toBe('task');
    expect(req.user).toBeUndefined();
    expect(req.accessToken).toBeUndefined();
    expect(fixture.link).toHaveBeenCalledWith({}, 'bot', '123');
  });
  it('resolves personal account events by session, never by remote sender or supplied account', async () => {
    const { req, next } = await invoke({
      'x-alia-channel': 'whatsapp',
      'x-alia-channel-session': 'connected-session',
      'x-alia-account-context': 'remote-sender',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(req.channelContext).toMatchObject({
      kind: 'account',
      accountId: ACCOUNT,
      identityId: 'connection',
    });
    expect(fixture.connection).toHaveBeenCalledWith({}, 'whatsapp', 'connected-session');
  });
  it.each(['external', 'wrong-workload', 'wrong-app'])(
    'rejects %s before reading any user link',
    async (kind) => {
      fixture.principal = {
        ...fixture.principal,
        ...(kind === 'external'
          ? { authority: 'external' }
          : kind === 'wrong-workload'
            ? { credentialId: 'other' }
            : { appId: 'other' }),
      };
      const { res, next } = await invoke({
        'x-alia-channel': 'telegram',
        'x-alia-platform-user': '123',
      });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(fixture.link).not.toHaveBeenCalled();
    },
  );
  it('refuses a removed link and never substitutes a supplied Oxy user', async () => {
    fixture.link.mockResolvedValue(null);
    const { res, next } = await invoke({
      'x-alia-channel': 'telegram',
      'x-alia-platform-user': '123',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    const spoof = await invoke({
      'x-alia-channel': 'telegram',
      'x-alia-platform-user': '123',
      'x-oxy-user-id': ACCOUNT,
    });
    expect(spoof.res.status).toHaveBeenCalledWith(403);
  });
  it('requires account provenance and rejects mixed provenance', async () => {
    for (const headers of [
      { 'x-alia-channel': 'telegram' },
      {
        'x-alia-channel': 'telegram',
        'x-alia-platform-user': '123',
        'x-alia-channel-session': 'session',
      },
    ]) {
      const { res, next } = await invoke(headers);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });
  it('does not grant private tools from a legacy connection without a task root', async () => {
    fixture.connection.mockResolvedValue({
      id: 'connection',
      oxyUserId: ACCOUNT,
      oxyTaskState: 'reauth_required',
      oxyTaskId: null,
    });
    const { req } = await invoke({
      'x-alia-channel': 'whatsapp',
      'x-alia-channel-session': 'session',
    });
    expect(req.channelContext.taskId).toBeUndefined();
    expect(req.accessToken).toBeUndefined();
  });
  it('pins administrative bot operations to their channel', async () => {
    const res = response();
    const next = vi.fn();
    await authenticateChannelBot('telegram')(
      { headers: { authorization: 'Bearer workload', 'x-alia-channel': 'discord' } } as any,
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
