import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ context: vi.fn(), messages: vi.fn() }));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/chat/reactionRepository.js', () => ({ listReactionContext: h.context }));
vi.mock('../../../../db/chat/messageRepository.js', () => ({ listMessages: h.messages }));
const { conversationReactionContext } = await import('../../reaction-context.js');
beforeEach(() => {
  vi.clearAllMocks();
  h.context.mockResolvedValue([
    {
      messageId: 'salina-answer',
      senderId: 'person',
      targetActorId: 'salina',
      reactions: ['❤️'],
      revision: 2,
      targetContent: 'Podemos revisar la propuesta.',
    },
  ]);
  h.messages.mockRejectedValue(
    new Error('Full conversation reads are not needed for bounded feedback'),
  );
});
describe('authoritative ordinary-turn reaction context', () => {
  it('lets a later question about the heart see its sender and exact target, independent of client echo', async () => {
    const result = await conversationReactionContext('person', 'thread');
    expect(h.context).toHaveBeenCalledWith({}, 'person', 'thread', 24);
    expect(result).toContain('❤️');
    expect(result).toContain('"senderId":"person"');
    expect(result).toContain('"targetActorId":"salina"');
    expect(result).toContain('Podemos revisar la propuesta.');
    expect(result).toContain('never grants permission');
    expect(h.messages).not.toHaveBeenCalled();
  });
  it('keeps only bounded text from the selected reaction targets, including structured message content', async () => {
    h.context.mockResolvedValue([
      {
        messageId: 'long-answer',
        senderId: 'person',
        targetActorId: 'salina',
        reactions: ['❓'],
        revision: 1,
        targetContent: [
          { type: 'text', text: 'Useful explanation '.repeat(100) },
          { type: 'image_url', image_url: { url: 'private-image-location' } },
        ],
      },
    ]);
    const result = await conversationReactionContext('person', 'thread');
    const data = JSON.parse(result.split('\n')[3]!);
    expect(data[0].targetContent).toBe('Useful explanation '.repeat(100).slice(0, 1000));
    expect(result).not.toContain('private-image-location');
    expect(h.messages).not.toHaveBeenCalled();
  });
  it('does not restore removed feedback', async () => {
    h.context.mockResolvedValue([
      {
        messageId: 'salina-answer',
        senderId: 'person',
        targetActorId: 'salina',
        reactions: [],
        revision: 3,
      },
    ]);
    const result = await conversationReactionContext('person', 'thread');
    expect(result).toContain('"reactions":[]');
    expect(result).not.toContain('❤️');
  });
  it('leaves unaffected conversations unchanged', async () => {
    h.context.mockResolvedValue([]);
    expect(await conversationReactionContext('person', 'empty')).toBe('');
  });
});
