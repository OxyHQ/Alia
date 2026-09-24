import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  findAgent: vi.fn(),
  findConversation: vi.fn(),
  createConversation: vi.fn(),
  upsertConversation: vi.fn(),
  countOutreach: vi.fn(),
  latestMarks: vi.fn(),
  findLast: vi.fn(),
  insert: vi.fn(),
  notify: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentById: H.findAgent }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findActiveThreadConversation: H.findConversation,
  createConversation: H.createConversation,
  upsertConversation: H.upsertConversation,
}));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  countAgentOutreachSince: H.countOutreach,
  listLatestMessageMarks: H.latestMarks,
  findLastMessage: H.findLast,
  insertMessages: H.insert,
}));
vi.mock('../../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: object) => ({ ...agent, name: 'Scout', handle: 'scout', color: 'blue' }),
  agentPromptName: (agent: { name: string }) => agent.name,
}));
vi.mock('../../notification-service.js', () => ({ sendNotification: H.notify }));
vi.mock('../../../socket.js', () => ({ getIO: () => ({ to: () => ({ emit: H.emit }) }) }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import { CHECK_IN_DAILY_LIMIT, postAgentMessage } from '../agent-outreach.js';

beforeEach(() => {
  vi.clearAllMocks();
  H.findAgent.mockResolvedValue({ _id: 'agent-1', oxyAccountId: 'bot-1' });
  H.findConversation.mockResolvedValue({ conversationId: 'conv-1' });
  H.countOutreach.mockResolvedValue(0);
  H.latestMarks.mockResolvedValue([{ role: 'user', clientMessageId: 'msg-3' }]);
  H.findLast.mockResolvedValue({ seq: 3 });
  H.insert.mockResolvedValue(undefined);
  H.notify.mockResolvedValue(undefined);
  H.upsertConversation.mockResolvedValue(undefined);
});

describe('an agent writing to a person first', () => {
  it('appends to the END of its conversation, marked, and tells the person', async () => {
    const outcome = await postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'check_in', content: 'Found it' });

    expect(outcome).toMatchObject({ posted: true, conversationId: 'conv-1' });
    const [[, [row]]] = H.insert.mock.calls as [[unknown, Array<Record<string, unknown>>]];
    expect(row).toMatchObject({ role: 'assistant', content: 'Found it', seq: 4 });
    expect(String(row.clientMessageId)).toMatch(/^agent-push-/);
    expect(H.emit).toHaveBeenCalledWith('conversation:message', expect.objectContaining({ conversationId: 'conv-1' }));
    expect(H.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', conversationId: 'conv-1', type: 'proactive_insight' }));
  });

  it('stops check-ins at the daily budget', async () => {
    H.countOutreach.mockResolvedValue(CHECK_IN_DAILY_LIMIT);

    await expect(postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'check_in', content: 'Again' }))
      .resolves.toEqual({ posted: false, reason: 'daily_limit' });
    expect(H.insert).not.toHaveBeenCalled();
  });

  it('stops check-ins when its last messages went unanswered', async () => {
    H.latestMarks.mockResolvedValue([
      { role: 'assistant', clientMessageId: 'agent-push-b' },
      { role: 'assistant', clientMessageId: 'agent-push-a' },
    ]);

    await expect(postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'check_in', content: 'Hello?' }))
      .resolves.toEqual({ posted: false, reason: 'unanswered' });
  });

  it('always delivers a result the person asked for, whatever the budget', async () => {
    H.countOutreach.mockResolvedValue(99);
    H.latestMarks.mockResolvedValue([
      { role: 'assistant', clientMessageId: 'agent-push-b' },
      { role: 'assistant', clientMessageId: 'agent-push-a' },
    ]);

    await expect(postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'result', content: 'Your report' }))
      .resolves.toMatchObject({ posted: true });
    expect(H.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_task_complete' }));
  });

  it('opens a conversation when the person has none with the agent yet', async () => {
    H.findConversation.mockResolvedValue(undefined);
    H.createConversation.mockResolvedValue({ conversationId: 'new-conv' });
    H.findLast.mockResolvedValue(undefined);

    const outcome = await postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'result', content: 'Hi' });

    expect(outcome).toMatchObject({ posted: true, conversationId: 'new-conv' });
    expect(H.createConversation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: 'agent-1', oxyUserId: 'u' }));
    const [[, [row]]] = H.insert.mock.calls as [[unknown, Array<Record<string, unknown>>]];
    expect(row).toMatchObject({ seq: 0 });
  });
});
