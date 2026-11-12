import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  reach: vi.fn(),
  hydrate: vi.fn(),
  save: vi.fn(),
  latest: vi.fn(),
  list: vi.fn(),
  space: vi.fn(),
  mint: vi.fn(),
  revoke: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../../activity.js', () => ({
  markConversationActive: vi.fn(async () => undefined),
  clearConversationActive: vi.fn(async () => undefined),
}));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/agents/agentRepository.js', () => ({ findAgentById: h.find }));
vi.mock('../../../../db/chat/messageRepository.js', () => ({
  findLatestUserMessage: h.latest,
  listMessages: h.list,
}));
vi.mock('../../../../db/spaces/spaceRepository.js', () => ({ findSpaceByConversation: h.space }));
vi.mock('../../../agent-account.js', () => ({ canReachAgent: h.reach }));
vi.mock('../../../agent-identity.js', () => ({
  attachAgentIdentity: h.hydrate,
  agentPromptName: (a: { name: string }) => a.name,
}));
vi.mock('../../../conversation-saver.js', () => ({ saveConversation: h.save }));
vi.mock('../../../oxy-task-authority.js', () => ({
  createOxyTask: h.mint,
  revokeOxyTask: h.revoke,
}));
vi.mock('../queue.js', () => ({ enqueueRoomJob: h.enqueue }));
vi.mock('../../../logger.js', () => ({
  log: { general: { error: vi.fn() }, agents: { warn: vi.fn() } },
}));
const { prepareRoom } = await import('../start.js');
const input = {
  userId: 'u',
  conversationId: 'room',
  memberAgentIds: ['s', 'e'],
  messages: [{ id: 'client-p', role: 'user', content: 'Eusebio, ¿qué puedes hacer?' }],
  accessToken: 'PRIVATE_BEARER',
  surfaceApplicationId: 'alia',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.find.mockImplementation(async (_db, id) => ({
    _id: id,
    oxyAccountId: `bot-${id}`,
    description: `${id} public remit`,
  }));
  h.reach.mockResolvedValue('reachable');
  h.hydrate.mockImplementation(async (agent) => ({
    ...agent,
    name: agent._id === 's' ? 'Salella' : 'Eusebio',
    handle: agent._id,
    color: null,
    character: null,
  }));
  h.latest.mockResolvedValue({ id: 'row-p', clientMessageId: 'client-p' });
  h.list.mockResolvedValue([]);
  h.space.mockResolvedValue(null);
  h.mint.mockImplementation(async ({ actorAccountId }) => `task-${actorAccountId}`);
});

describe('room preparation', () => {
  it('cannot enqueue work when durable activity admission fails', async () => {
    const { markConversationActive } = await import('../../activity.js');
    vi.mocked(markConversationActive).mockRejectedValueOnce(new Error('admission unavailable'));
    const room = await prepareRoom(input);
    await expect(room.start()).rejects.toThrow('admission unavailable');
    expect(h.enqueue).not.toHaveBeenCalled();
    await room.abandon();
    expect(h.revoke).toHaveBeenCalled();
  });
  it('queues selection, not a roster-wide round, with no bearer in its data', async () => {
    const room = await prepareRoom(input);
    expect(room.ready).toBe(true);
    await room.start();
    expect(h.enqueue).toHaveBeenCalledOnce();
    const job = h.enqueue.mock.calls[0]?.[0];
    expect(job).toMatchObject({
      version: 2,
      phase: 'select',
      triggerId: 'row-p',
      speakerId: '',
      pending: [],
    });
    expect(JSON.stringify(job)).not.toContain('PRIVATE_BEARER');
    expect(job.roster[1]).toMatchObject({
      description: 'e public remit',
      oxyTaskId: 'task-bot-e',
      available: true,
    });
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.mint.mock.invocationCallOrder[0]!);
  });

  it('keeps unavailable Eusebio identifiable, without task authority or private description', async () => {
    h.reach.mockImplementation(async (agent) => (agent._id === 'e' ? 'unreachable' : 'reachable'));
    const room = await prepareRoom(input);
    await room.start();
    const e = h.enqueue.mock.calls[0]?.[0].roster[1];
    expect(e).toMatchObject({ info: { id: 'e', name: 'Eusebio' }, available: false });
    expect(e.oxyTaskId).toBeUndefined();
    expect(e.description).toBeUndefined();
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  it('does not lose a known unavailable identity when authority lookup fails', async () => {
    h.reach.mockRejectedValue(new Error('Oxy down'));
    const room = await prepareRoom(input);
    expect(room.ready).toBe(false);
    expect(h.mint).not.toHaveBeenCalled();
    await room.start();
    expect(h.enqueue.mock.calls[0]?.[0].roster[1]).toMatchObject({
      info: { name: 'Eusebio' },
      available: false,
    });
  });

  it('does not mint authority when space preparation fails', async () => {
    h.space.mockRejectedValue(new Error('database down'));
    await expect(prepareRoom(input)).rejects.toThrow('database down');
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('abandon revokes only the tasks actually minted', async () => {
    h.mint.mockResolvedValueOnce('task-s').mockRejectedValueOnce(new Error('unavailable'));
    const room = await prepareRoom(input);
    await room.abandon();
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('task-s');
  });

  it('binds its own stored trigger even when a newer request wins the latest-message race', async () => {
    h.latest.mockResolvedValue({ id: 'row-newer', clientMessageId: 'newer' });
    h.list.mockResolvedValue([{ id: 'row-p', clientMessageId: 'client-p' }]);
    const room = await prepareRoom(input);
    expect(room.chainId).toBe('row-p');
    await room.start();
    expect(h.enqueue.mock.calls[0]?.[0].triggerId).toBe('row-p');
  });
});
