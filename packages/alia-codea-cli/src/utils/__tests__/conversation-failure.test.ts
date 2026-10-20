import { describe, expect, it, vi } from 'vitest';

const streamChat = vi.fn();
vi.mock('../api.js', () => ({ streamChat: (...args: unknown[]) => streamChat(...args) }));
vi.mock('../../tools/executor.js', () => ({ executeTool: vi.fn() }));

import { processConversation, type ConversationEvent, type Message } from '../conversation.js';

describe('a turn whose stream failed after it started', () => {
  it('reports the error, saves nothing as the answer and never says done', async () => {
    streamChat.mockImplementation(
      async (
        _messages: unknown,
        _system: unknown,
        _model: unknown,
        callbacks: { onContent: (text: string) => void; onError: (error: Error) => void },
      ) => {
        callbacks.onContent('half an ans');
        callbacks.onError(new Error('Down (PROVIDER_UNAVAILABLE · Ref chatcmpl-1)'));
      },
    );
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const events: ConversationEvent[] = [];

    await processConversation({
      messages,
      systemMessage: 's',
      model: 'm',
      approvalMode: 'auto' as never,
      onEvent: (event) => events.push(event),
      requestApproval: async () => true,
      isActive: () => true,
    });

    expect(events.map((event) => event.type)).toEqual(['thinking', 'content', 'error']);
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
