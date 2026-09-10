import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which prompt a regenerate replays.
 *
 * Regenerating an answer is re-sending the question that produced it, so the
 * whole behaviour is a search backwards through the thread for the user turn
 * that came before the answer you pressed on. The ways that search goes wrong
 * are all silent: land on the wrong user turn and you regenerate a different
 * question; stop at the first thing that is not an assistant and you replay a
 * tool or system message; read the assistant's own text and you ask Alia to
 * answer itself.
 *
 * So the assertion is on WHICH message id and WHICH text reached `editMessage`
 * — never merely that regenerating called something.
 */

const chat = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: unknown }[],
  /** Every `append` the hook made, which is how a replayed prompt leaves. */
  appended: [] as { role: string; content: string }[],
  /** The list after the hook truncated it, i.e. what the replay is sent onto. */
  setTo: null as unknown,
}));

vi.mock('@/lib/hooks/use-streaming-chat', () => ({
  useStreamingChat: () => ({
    messages: chat.messages,
    append: vi.fn(async (m: { role: string; content: string }) => {
      chat.appended.push(m);
      return 'sent';
    }),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
    setMessages: vi.fn((next: unknown) => {
      chat.setTo = typeof next === 'function'
        ? (next as (p: unknown) => unknown)(chat.messages)
        : next;
    }),
    stop: vi.fn(),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: vi.fn(),
  }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/hooks/use-conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: vi.fn() }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Platform modules the hook imports for its SEND path. Neither takes part in
// choosing which prompt a regenerate replays; they are here because importing
// them pulls React Native's Flow source into the runner.
vi.mock('@/lib/attachment-utils', () => ({ buildMessageContent: (text: string) => text }));
vi.mock('@/lib/generate-api-url', () => ({ generateAPIUrl: () => 'http://test.invalid/chat' }));
vi.mock('@/lib/i18n', () => ({ default: { t: (k: string) => k } }));

import { useChatConversation } from '@/lib/hooks/use-chat-conversation';

let api: ReturnType<typeof useChatConversation>;

function Probe() {
  api = useChatConversation({ conversationId: 'c1' });
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  chat.messages = [];
  chat.appended = [];
  chat.setTo = null;
});

describe('regenerateMessage', () => {
  it('replays the user turn immediately before the answer, not a later one', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: 'first question' },
      { id: 'a1', role: 'assistant', content: 'first answer' },
      { id: 'u2', role: 'user', content: 'second question' },
      { id: 'a2', role: 'assistant', content: 'second answer' },
    ];
    await mount();

    await act(async () => { await api.regenerateMessage('a1'); });

    expect(chat.appended).toEqual([{ role: 'user', content: 'first question' }]);
    // Truncated to before u1, so the replay lands where the first answer was.
    expect(chat.setTo).toEqual([]);
  });

  it('skips over non-user turns between the answer and its prompt', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: 'the question' },
      { id: 's1', role: 'system', content: 'a system note' },
      { id: 'a1', role: 'assistant', content: 'the answer' },
    ];
    await mount();

    await act(async () => { await api.regenerateMessage('a1'); });

    expect(chat.appended).toEqual([{ role: 'user', content: 'the question' }]);
  });

  it('reads text out of a multi-part user turn rather than sending nothing', async () => {
    chat.messages = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          { type: 'text', text: 'what is in this picture' },
        ],
      },
      { id: 'a1', role: 'assistant', content: 'a picture' },
    ];
    await mount();

    await act(async () => { await api.regenerateMessage('a1'); });

    expect(chat.appended).toEqual([{ role: 'user', content: 'what is in this picture' }]);
  });

  it('does nothing when the answer has no user turn before it', async () => {
    chat.messages = [{ id: 'a1', role: 'assistant', content: 'an opening line' }];
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.regenerateMessage('a1'); });

    expect(outcome).toBe(false);
    expect(chat.appended).toEqual([]);
  });

  it('does nothing when the id is not in the thread', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'a' },
    ];
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.regenerateMessage('nope'); });

    expect(outcome).toBe(false);
    expect(chat.appended).toEqual([]);
  });
});
