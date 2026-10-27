import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));

const { readSharedConversation, sharedMessages } = await import('../../src/runtime/sharing');

/** A shared conversation (`GET /v1/shared/:token`): words, pictures, who wrote them and its artifacts. */
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

  it('keeps the canvas artifacts of a reply and hands them to the thread as canvas calls', () => {
    const dashboard = {
      id: 'call-2',
      type: 'dashboard',
      title: 'Shortlist',
      data: { widgets: [{ kind: 'stat', label: 'Rent', value: '1,250' }] },
    };
    const shared = readSharedConversation({
      title: 't',
      expiresAt: '2026-10-20T00:00:00Z',
      messages: [
        { role: 'user', content: 'hola', artifacts: [dashboard] },
        {
          role: 'assistant',
          content: '',
          artifacts: [
            dashboard,
            { id: 'x', type: 'markdown', title: 'no data' },
            { type: 'markdown', title: 'no id', data: { content: 'a' } },
            'canvas',
          ],
        },
      ],
    });
    if (shared === null) throw new Error('the shared conversation was refused');
    expect(shared.messages).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '', artifacts: [dashboard] },
    ]);
    const [question, reply] = sharedMessages(shared);
    expect(question?.toolInvocations).toBeUndefined();
    expect(reply?.toolInvocations).toEqual([
      {
        toolCallId: 'call-2',
        toolName: 'canvas',
        state: 'result',
        result: { type: 'dashboard', title: 'Shortlist', data: dashboard.data },
      },
    ]);
  });

  it('refuses a body without messages or an expiry', () => {
    expect(readSharedConversation({ title: 'x', messages: [] })).toBeNull();
    expect(readSharedConversation({ expiresAt: 'x' })).toBeNull();
  });
});

/** Every app shares the same link: Alia's one shared-conversation page. */
describe('aliaSharedConversationUrl', () => {
  it("is Alia's page for the token, encoded", async () => {
    const { aliaSharedConversationUrl } = await import('../../src/lib/origins');
    expect(aliaSharedConversationUrl('ab/c d')).toBe('https://alia.onl/shared/ab%2Fc%20d');
  });
});
