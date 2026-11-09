import { beforeEach, describe, expect, it, vi } from 'vitest';

const claim = vi.fn();
const claimStalled = vi.fn();
const settle = vi.fn(() => Promise.resolve());
const purge = vi.fn(() => Promise.resolve());
const findBotUserById = vi.fn();
const findInboundUserBotById = vi.fn();
const processAgentBotMessage = vi.fn(() => Promise.resolve());
const processChannelMessage = vi.fn(() => Promise.resolve());

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/botRepository.js', () => ({
  findBotUserById,
  findInboundUserBotById,
}));
vi.mock('../../../db/integrations/channelInboundRepository.js', () => ({
  claimChannelInbound: claim,
  claimStalledChannelInbound: claimStalled,
  settleChannelInbound: settle,
  purgeChannelInbound: purge,
}));
vi.mock('../inbound-handlers.js', () => ({ processAgentBotMessage, processChannelMessage }));

const { processAcceptedChannelInbound, reapStalledChannelInbound } = await import(
  '../inbound-sweep.js'
);

const message = { platformUserId: 'p', chatId: 'c', text: 'hola' };
const work = (kind: 'system' | 'agent_bot') => ({
  id: 'in-1',
  kind,
  channelType: 'telegram',
  botId: 'bot-1',
  botUserId: 'bu-1',
  message,
  attempts: 1,
});

describe('inbound sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findBotUserById.mockResolvedValue({ id: 'bu-1' });
    findInboundUserBotById.mockResolvedValue({ id: 'bot-1' });
  });

  it('answers a system-bot message and settles it done', async () => {
    claim.mockResolvedValue(work('system'));
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).toHaveBeenCalledWith('telegram', { id: 'bu-1' }, message);
    expect(processAgentBotMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'done');
  });

  it('answers an agent-bot message with its bot, and settles it done', async () => {
    claim.mockResolvedValue(work('agent_bot'));
    await processAcceptedChannelInbound('in-1');
    expect(processAgentBotMessage).toHaveBeenCalledWith(
      { id: 'bot-1' },
      { id: 'bu-1' },
      message,
      'telegram',
    );
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'done');
  });

  it('does nothing when another instance already holds the message', async () => {
    claim.mockResolvedValue(null);
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles failed, without throwing, when the handler throws', async () => {
    claim.mockResolvedValue(work('system'));
    processChannelMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(processAcceptedChannelInbound('in-1')).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'failed');
  });

  it('fails a message whose bot was deleted instead of answering it', async () => {
    claim.mockResolvedValue(work('agent_bot'));
    findInboundUserBotById.mockResolvedValue(null);
    await processAcceptedChannelInbound('in-1');
    expect(processAgentBotMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'failed');
  });

  it('fails a message whose person is gone', async () => {
    claim.mockResolvedValue(work('system'));
    findBotUserById.mockResolvedValue(null);
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'failed');
  });

  it('reaps stalled messages, answers each, and purges', async () => {
    claimStalled.mockResolvedValue([work('system'), { ...work('agent_bot'), id: 'in-2' }]);
    expect(await reapStalledChannelInbound()).toBe(2);
    expect(processChannelMessage).toHaveBeenCalledTimes(1);
    expect(processAgentBotMessage).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
