import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What "Clear conversation" does once the dialog says yes (#553).
 *
 * The header confirmed under "This action cannot be undone" and then reset
 * the local message list and nothing else — the cached history hydrated
 * straight back on the next render. The fix is an ORDER: the server clear
 * runs first, and only once it has succeeded is the screen reset. Every case
 * below is about that order, or about what happens when it cannot complete:
 *
 * - the request goes out exactly once, and the screen empties AFTER it
 *   resolves, not before;
 * - a refusal leaves the screen as it was and surfaces the error — the state
 *   this hook must never produce is a cleared view whose history is about to
 *   return;
 * - a turn still streaming is stopped BEFORE the request, so the thread being
 *   emptied is one nothing is writing into.
 *
 * `useClearConversation` is mocked: what it does to the query cache on success
 * is its own contract, pinned in `use-clear-conversation.test.tsx`.
 */

const chat = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: unknown }[],
  isLoading: false,
  /** Every observable side effect, in the order it happened. The order IS the assertion. */
  sequence: [] as string[],
  /** What the mocked server clear does: resolve, or refuse. */
  clearOutcome: 'ok' as 'ok' | Error,
}));

vi.mock('@/lib/hooks/use-streaming-chat', () => ({
  useStreamingChat: () => ({
    messages: chat.messages,
    append: vi.fn(async () => 'sent'),
    isLoading: chat.isLoading,
    error: null,
    clearError: vi.fn(),
    setMessages: vi.fn((next: unknown) => {
      const resolved = typeof next === 'function'
        ? (next as (p: unknown) => unknown)(chat.messages)
        : next;
      chat.sequence.push(`setMessages:${JSON.stringify(resolved)}`);
    }),
    stop: vi.fn(() => { chat.sequence.push('stop'); }),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: vi.fn(),
    failedTurn: null,
    retryFailedTurn: vi.fn(),
    clearFailedTurn: vi.fn(() => { chat.sequence.push('clearFailedTurn'); }),
  }),
}));

vi.mock('@/lib/stores/global-store', () => {
  const state = {
    pendingInitialMessage: null,
    setStreamingChatId: vi.fn(),
    streamingChatId: null,
    setChatId: vi.fn(),
    setBottomChatHeightHandler: vi.fn(),
    clearAttachments: vi.fn(),
    setAttachments: vi.fn(),
    setComposerDraft: vi.fn(),
    clearPendingInitialMessage: vi.fn(),
    setPendingInitialMessage: vi.fn(),
  };
  const useStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useStore };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/hooks/use-conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: vi.fn() }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useClearConversation: () => ({
    mutateAsync: vi.fn(async (id: string) => {
      chat.sequence.push(`clear:${id}`);
      if (chat.clearOutcome !== 'ok') throw chat.clearOutcome;
      return id;
    }),
  }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
// Platform modules the hook imports for its SEND path. None takes part in a
// clear; they are here because importing them pulls React Native's Flow
// source into the runner.
vi.mock('@/lib/attachment-utils', () => ({ buildMessageContent: (text: string) => text }));
vi.mock('@/lib/generate-api-url', () => ({ generateAPIUrl: () => 'http://test.invalid/chat' }));
vi.mock('@/lib/i18n', () => ({ default: { t: (k: string) => k } }));

import { useChatConversation } from '@/lib/hooks/use-chat-conversation';

let api: ReturnType<typeof useChatConversation>;

function Probe({ conversationId }: { conversationId?: string }) {
  api = useChatConversation({ conversationId });
  return null;
}

/** `null` mounts a screen with no conversation id — `undefined` would take the default. */
async function mount(conversationId: string | null = 'c1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(
      <QueryClientProvider client={client}>
        <Probe conversationId={conversationId ?? undefined} />
      </QueryClientProvider>,
    );
  });
  // Mounting syncs the (empty) detail query into the screen, which is one
  // `setMessages` of its own; only what the clear does afterwards is measured.
  chat.sequence = [];
}

const HISTORY = [
  { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
  { id: 'a1', role: 'assistant', content: 'Lima' },
];

beforeEach(() => {
  chat.messages = HISTORY;
  chat.isLoading = false;
  chat.sequence = [];
  chat.clearOutcome = 'ok';
  toast.error.mockClear();
});

describe('clearConversation', () => {
  it('clears on the server exactly once, and only then empties the screen', async () => {
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.clearConversation(); });

    expect(outcome).toBe(true);
    // The request first; the local reset only after it resolved. The reverse
    // order is the bug: a screen emptied while the cache still held the
    // history, which the sync effect then restored.
    expect(chat.sequence).toEqual(['clear:c1', 'setMessages:[]', 'clearFailedTurn']);
    expect(chat.sequence.filter((step) => step.startsWith('clear:'))).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the history and surfaces the error when the server refuses', async () => {
    chat.clearOutcome = new Error('500 from the API');
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.clearConversation(); });

    expect(outcome).toBe(false);
    // Nothing local moved: no reset, no failed-turn clear. The one state this
    // must never produce is an empty view whose history is about to return.
    expect(chat.sequence).toEqual(['clear:c1']);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('chatHeader.clearFailed');
  });

  it('stops a turn still streaming BEFORE it clears', async () => {
    chat.isLoading = true;
    await mount();

    await act(async () => { await api.clearConversation(); });

    // The abort comes first, so the thread being emptied is one nothing is
    // still writing into; then the same order as an idle clear.
    expect(chat.sequence).toEqual(['stop', 'clear:c1', 'setMessages:[]', 'clearFailedTurn']);
  });

  it('does not stop anything when nothing is streaming', async () => {
    await mount();

    await act(async () => { await api.clearConversation(); });

    expect(chat.sequence).not.toContain('stop');
  });

  it('resets locally with no request when there is no conversation to clear', async () => {
    await mount(null);

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.clearConversation(); });

    // Nothing is persisted for a thread without an id, so the screen's own
    // list is all there is to empty.
    expect(outcome).toBe(true);
    expect(chat.sequence).toEqual(['setMessages:[]', 'clearFailedTurn']);
  });
});
