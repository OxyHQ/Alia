import { describe, expect, it, vi } from 'vitest';

/**
 * Stopping between the tools of one round must not leave tool calls without results in the
 * session that gets saved.
 */

vi.mock('../api.js', () => ({
  streamChat: async (
    _messages: unknown,
    _system: string,
    _model: string,
    handlers: { onDone: (content: string, calls: unknown[]) => void },
  ) => {
    handlers.onDone('', [
      { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ]);
  },
}));

const world = vi.hoisted(() => ({ active: true }));
vi.mock('../../tools/executor.js', () => ({
  executeTool: async () => {
    world.active = false; // Ctrl+C while the first tool runs
    return { success: true, result: 'ok' };
  },
}));

import { type Message, processConversation } from '../conversation.js';

describe('processConversation stopped mid-round', () => {
  it('answers every tool call it asked for', async () => {
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    await processConversation({
      messages,
      systemMessage: '',
      model: 'm',
      approvalMode: 'full-auto',
      onEvent: () => {},
      requestApproval: async () => true,
      isActive: () => world.active,
    });

    const asked = messages.find((m) => m.tool_calls)?.tool_calls?.map((c) => c.id);
    const answered = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(answered).toEqual(['a', 'b', 'c']);
  });
});
