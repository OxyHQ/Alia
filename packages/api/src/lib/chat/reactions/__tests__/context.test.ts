import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ context: vi.fn(), messages: vi.fn() }));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/chat/reactionRepository.js', () => ({ listReactionContext: h.context }));
vi.mock('../../../../db/chat/messageRepository.js', () => ({ listMessages: h.messages }));
const { conversationReactionContext } = await import('../../reaction-context.js');
beforeEach(() => {
  h.context.mockResolvedValue([
    {
      messageId: 'salina-answer',
      senderId: 'person',
      targetActorId: 'salina',
      reactions: ['❤️'],
      revision: 2,
    },
  ]);
  h.messages.mockResolvedValue([
    { id: 'new-row', clientMessageId: 'salina-answer', content: 'Podemos revisar la propuesta.' },
  ]);
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
