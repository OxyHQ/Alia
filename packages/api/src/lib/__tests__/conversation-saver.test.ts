import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock model + collaborator modules before importing the unit under test.
vi.mock('../../models/conversation.js', () => ({
  Conversation: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../models/message.js', () => ({
  Message: {
    countDocuments: vi.fn(),
    findOne: vi.fn(),
    insertMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn(),
  getAIModel: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: {
    chat: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    v1: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { saveConversation } from '../conversation-saver.js';
import { Conversation } from '../../models/conversation.js';
import { Message } from '../../models/message.js';

const mockConversation = Conversation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockMessage = Message as unknown as Record<string, ReturnType<typeof vi.fn>>;

interface StoredTail {
  seq?: number;
  role: string;
  content: unknown;
}

/** Build the findOne().sort().select().lean() chain returning the given tail. */
function mockLastStored(value: StoredTail | null): void {
  mockMessage.findOne.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  });
}

const USER = 'user-1';
const CONV = 'conv-1';

describe('saveConversation (append-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversation.findOneAndUpdate.mockResolvedValue({});
    mockMessage.insertMany.mockResolvedValue([]);
    mockMessage.deleteMany.mockResolvedValue({ deletedCount: 0 });
  });

  it('(e) first save on an empty conversation appends without deleting', async () => {
    mockMessage.countDocuments.mockResolvedValue(0);
    mockLastStored(null);

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'A1',
    });

    expect(mockMessage.deleteMany).not.toHaveBeenCalled();
    expect(mockMessage.insertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = mockMessage.insertMany.mock.calls[0];
    expect(docs).toHaveLength(2);
    expect(docs.map((d: { seq: number; role: string }) => [d.seq, d.role])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
    ]);
    expect(opts).toEqual({ ordered: true });
  });

  it('(a) second save appends only the new turn (no delete)', async () => {
    // Stored: [user1(0), assistant1(1)]. Client resends both + a new user turn.
    mockMessage.countDocuments.mockResolvedValue(2);
    mockLastStored({ seq: 1, role: 'assistant', content: 'A1' });

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      assistantResponse: 'A2',
    });

    expect(mockMessage.deleteMany).not.toHaveBeenCalled();
    expect(mockMessage.insertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = mockMessage.insertMany.mock.calls[0];
    expect(docs).toHaveLength(2);
    expect(docs.map((d: { seq: number; content: unknown }) => [d.seq, d.content])).toEqual([
      [2, 'U2'],
      [3, 'A2'],
    ]);
    expect(opts).toEqual({ ordered: true });
  });

  it('(b) edited history diverges from stored tail → full rewrite', async () => {
    mockMessage.countDocuments.mockResolvedValue(2);
    // Stored last assistant content differs from what the client resent.
    mockLastStored({ seq: 1, role: 'assistant', content: 'EDITED-DIFFERENT' });

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      assistantResponse: 'A2',
    });

    expect(mockMessage.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockMessage.deleteMany).toHaveBeenCalledWith({ conversationId: CONV, oxyUserId: USER });
    expect(mockMessage.insertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = mockMessage.insertMany.mock.calls[0];
    expect(docs).toHaveLength(4);
    expect(docs.map((d: { seq: number }) => d.seq)).toEqual([0, 1, 2, 3]);
    expect(opts).toEqual({ ordered: false });
  });

  it('(c) legacy conversation (stored tail has no seq) → full rewrite', async () => {
    mockMessage.countDocuments.mockResolvedValue(2);
    mockLastStored({ role: 'assistant', content: 'A1' }); // no seq field

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      assistantResponse: 'A2',
    });

    expect(mockMessage.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockMessage.insertMany).toHaveBeenCalledTimes(1);
    expect(mockMessage.insertMany.mock.calls[0][0]).toHaveLength(4);
  });

  it('(d) duplicate-key on append falls back to a full rewrite', async () => {
    mockMessage.countDocuments.mockResolvedValue(2);
    mockLastStored({ seq: 1, role: 'assistant', content: 'A1' });
    // First (append) insert races and hits a unique-seq violation.
    mockMessage.insertMany
      .mockRejectedValueOnce({ code: 11000, message: 'E11000 duplicate key' })
      .mockResolvedValueOnce([]);

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      assistantResponse: 'A2',
    });

    expect(mockMessage.insertMany).toHaveBeenCalledTimes(2);
    expect(mockMessage.deleteMany).toHaveBeenCalledTimes(1);
    // Append attempt inserts the delta; rewrite reinserts the whole thread.
    expect(mockMessage.insertMany.mock.calls[0][0]).toHaveLength(2);
    expect(mockMessage.insertMany.mock.calls[1][0]).toHaveLength(4);
    expect(mockMessage.insertMany.mock.calls[1][1]).toEqual({ ordered: false });
  });

  it('re-throws non-duplicate insert errors instead of masking them', async () => {
    mockMessage.countDocuments.mockResolvedValue(0);
    mockLastStored(null);
    mockMessage.insertMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      saveConversation({
        userId: USER,
        conversationId: CONV,
        messages: [{ role: 'user', content: 'U1' }],
        assistantResponse: 'A1',
      }),
    ).rejects.toThrow('connection lost');
    // A non-E11000 failure must NOT trigger the destructive rewrite path.
    expect(mockMessage.deleteMany).not.toHaveBeenCalled();
  });
});
