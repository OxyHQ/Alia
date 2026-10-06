import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  claim: vi.fn(),
  findConversation: vi.fn(),
  upsert: vi.fn(),
  lastMessage: vi.fn(),
  insert: vi.fn(),
  notify: vi.fn(),
  emit: vi.fn(),
  to: vi.fn(),
  countOutreach: vi.fn(),
  latestMarks: vi.fn(),
}));

const database = { kind: 'test-db' };

vi.mock('../../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../../db/automation/automationDefinitionRepository.js', () => ({
  claimAutomationConversation: state.claim,
}));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findConversation: state.findConversation,
  upsertConversation: state.upsert,
}));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  findLastMessage: state.lastMessage,
  insertMessages: state.insert,
  countOutreachInConversationSince: state.countOutreach,
  listLatestMessageMarks: state.latestMarks,
}));
vi.mock('../../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('../../../socket.js', () => ({ getIO: () => ({ to: state.to }) }));
vi.mock('../../logger.js', () => ({ log: { agents: { warn: vi.fn() } } }));

import { aliaOutreachConversationId, postAliaCheckIn, postAliaMessage } from '../alia-outreach.js';
import { CHECK_IN_DAILY_LIMIT } from '../outreach-budget.js';

const base = {
  oxyUserId: 'owner-1',
  automationId: 'automation-1',
  objective: 'Track the latest releases from Meta',
  content: 'Meta announced Llama 5 today.',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.claim.mockImplementation(async (_db, _id, proposed: string) => proposed);
  state.findConversation.mockResolvedValue(undefined);
  state.upsert.mockResolvedValue({});
  state.lastMessage.mockResolvedValue(undefined);
  state.insert.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
  state.to.mockReturnValue({ emit: state.emit });
  state.countOutreach.mockResolvedValue(0);
  state.latestMarks.mockResolvedValue([{ role: 'user', clientMessageId: 'msg-1' }]);
});

describe('Alia posting a task result', () => {
  it('opens the task conversation on the first result, titled by the objective, with no agent', async () => {
    const outcome = await postAliaMessage({ ...base, conversationId: null });

    expect(outcome).toEqual({ posted: true, conversationId: expect.any(String), messageId: expect.stringMatching(/^agent-push-/) });
    const { conversationId } = outcome as { conversationId: string };
    expect(state.claim).toHaveBeenCalledWith(database, 'automation-1', conversationId);
    expect(state.upsert).toHaveBeenNthCalledWith(1, database, {
      oxyUserId: 'owner-1',
      conversationId,
      titleOnInsert: 'Track the latest releases from Meta',
      source: 'app',
    });
    expect(state.upsert.mock.calls[0]?.[1]).not.toHaveProperty('agentId');
    expect(state.insert).toHaveBeenCalledWith(database, [expect.objectContaining({
      conversationId,
      oxyUserId: 'owner-1',
      role: 'assistant',
      content: 'Meta announced Llama 5 today.',
      seq: 0,
    })]);
  });

  it('appends to the stored conversation after its last message, then tells the person', async () => {
    state.findConversation.mockResolvedValue({ conversationId: 'conversation-1' });
    state.lastMessage.mockResolvedValue({ seq: 6, role: 'assistant', content: 'Earlier result' });

    await postAliaMessage({ ...base, conversationId: 'conversation-1' });

    expect(state.claim).not.toHaveBeenCalled();
    expect(state.insert).toHaveBeenCalledWith(database, [expect.objectContaining({ seq: 7 })]);
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect(state.upsert).toHaveBeenCalledWith(database, expect.objectContaining({
      conversationId: 'conversation-1',
      lastMessage: 'Meta announced Llama 5 today.',
    }));
    expect(state.to).toHaveBeenCalledWith('user:owner-1');
    expect(state.emit).toHaveBeenCalledWith('conversation:message', expect.objectContaining({
      conversationId: 'conversation-1',
      message: expect.objectContaining({ role: 'assistant', content: 'Meta announced Llama 5 today.' }),
    }));
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      title: 'Track the latest releases from Meta',
      conversationId: 'conversation-1',
      data: expect.objectContaining({ conversationId: 'conversation-1', automationId: 'automation-1' }),
    }));
  });

  it('retries the append when a concurrent turn took the same seq', async () => {
    state.findConversation.mockResolvedValue({ conversationId: 'conversation-1' });
    state.lastMessage.mockResolvedValueOnce({ seq: 1 }).mockResolvedValueOnce({ seq: 2 });
    state.insert.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'messages_oxy_user_conversation_seq_key',
    }));

    await postAliaMessage({ ...base, conversationId: 'conversation-1' });

    expect(state.insert).toHaveBeenCalledTimes(2);
    expect(state.insert).toHaveBeenLastCalledWith(database, [expect.objectContaining({ seq: 3 })]);
  });

  it('posts nothing for an empty result', async () => {
    await expect(postAliaMessage({ ...base, conversationId: null, content: '  ' }))
      .resolves.toEqual({ posted: false, reason: 'empty' });
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });
});

describe('Alia writing first, on her own initiative', () => {
  const checkIn = { oxyUserId: 'owner-1', content: 'An important email arrived.', title: 'Important email', conversationTitle: 'Alia' };

  it('uses one conversation of hers per person, derived rather than stored', () => {
    const id = aliaOutreachConversationId('owner-1');
    expect(id).toBe(aliaOutreachConversationId('owner-1'));
    expect(id).not.toBe(aliaOutreachConversationId('owner-2'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('posts into it, marked, and notifies as a proactive insight', async () => {
    const outcome = await postAliaCheckIn({ ...checkIn, data: { emailId: 'msg-1' } });

    const conversationId = aliaOutreachConversationId('owner-1');
    expect(outcome).toEqual({ posted: true, conversationId, messageId: expect.stringMatching(/^agent-push-/) });
    expect(state.upsert).toHaveBeenNthCalledWith(1, database, expect.objectContaining({ conversationId, titleOnInsert: 'Alia' }));
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'proactive_insight',
      title: 'Important email',
      data: expect.objectContaining({ conversationId, emailId: 'msg-1' }),
    }));
  });

  it('spends the agents\' budget: three a day', async () => {
    state.countOutreach.mockResolvedValue(CHECK_IN_DAILY_LIMIT);
    await expect(postAliaCheckIn(checkIn)).resolves.toEqual({ posted: false, reason: 'daily_limit' });
    expect(state.insert).not.toHaveBeenCalled();
  });

  it('and none while her last two went unanswered', async () => {
    state.latestMarks.mockResolvedValue([
      { role: 'assistant', clientMessageId: 'agent-push-a' },
      { role: 'assistant', clientMessageId: 'agent-push-b' },
    ]);
    await expect(postAliaCheckIn(checkIn)).resolves.toEqual({ posted: false, reason: 'unanswered' });
    expect(state.notify).not.toHaveBeenCalled();
  });
});
