import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));

const { readSharedConversation, sharedMessages } = await import('../../src/runtime/sharing');

/** A shared conversation (`GET /v1/shared/:token`): words, pictures and who wrote them. */
describe('readSharedConversation', () => {
  it('keeps the messages the contract names, with the agent that wrote each', () => {
    const shared = readSharedConversation({
      title: 'Pisos en Barcelona',
      agent: { id: 'sindi', name: 'Sindi', character: { x: 1 } },
      expiresAt: '2026-10-20T00:00:00Z',
      messages: [
        { role: 'user', content: 'pisos' },
        { role: 'assistant', content: 'Dos.', agent: { id: 'sindi', name: 'Sindi' } },
        { role: 'tool', content: 'secret' },
        { role: 'assistant', content: 42 },
      ],
    });
    expect(shared).toEqual({
      title: 'Pisos en Barcelona',
      agent: { id: 'sindi', name: 'Sindi', character: { x: 1 } },
      expiresAt: '2026-10-20T00:00:00Z',
      messages: [
        { role: 'user', content: 'pisos' },
        { role: 'assistant', content: 'Dos.', agent: { id: 'sindi', name: 'Sindi' } },
      ],
    });
    if (shared === null) throw new Error('the shared conversation was refused');
    expect(sharedMessages(shared)[1]).toMatchObject({
      role: 'assistant',
      agentInfo: { id: 'sindi', name: 'Sindi' },
    });
  });

  it('refuses a body without messages or an expiry', () => {
    expect(readSharedConversation({ title: 'x', messages: [] })).toBeNull();
    expect(readSharedConversation({ expiresAt: 'x' })).toBeNull();
  });
});
