import { describe, expect, it } from 'vitest';
import type { Message } from '@/lib/hooks/use-conversations';
import {
  buildOutboundMessages,
  normalizeConversationMessages,
} from '../chat-message-history';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content };
}

describe('chat message history', () => {
  it('builds a send from the pre-optimistic snapshot exactly once', () => {
    const previous = message('assistant-1', 'assistant', 'Previous answer');
    const current = message('user-2', 'user', 'Write Python');
    const optimisticPlaceholder = message('assistant-2', 'assistant', '');

    // This is the ref state that can exist after collectDeviceInfo resolves.
    const advancedUiState = [previous, current, optimisticPlaceholder];
    const payload = buildOutboundMessages([previous], current);

    expect(advancedUiState).toHaveLength(3);
    expect(payload).toEqual([
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Write Python' },
    ]);
  });

  it('collapses the exact historical optimistic-send artifact', () => {
    const stored = [
      message('msg-0', 'user', 'Write, debug, or explain Python code snippets'),
      message('msg-1', 'assistant', ''),
      message('msg-2', 'user', 'Write, debug, or explain Python code snippets'),
      message('msg-3', 'assistant', 'Please provide the specific snippet.'),
    ];

    expect(normalizeConversationMessages(stored)).toEqual([stored[0], stored[3]]);
  });

  it('preserves an intentional repeated prompt after a real response', () => {
    const stored = [
      message('msg-0', 'user', 'Try again'),
      message('msg-1', 'assistant', 'First answer'),
      message('msg-2', 'user', 'Try again'),
    ];

    expect(normalizeConversationMessages(stored)).toEqual(stored);
  });
});
