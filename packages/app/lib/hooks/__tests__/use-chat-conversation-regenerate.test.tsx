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
 * So the assertion is on WHICH message id and WHICH content reached `append`
 * — never merely that regenerating called something.
 *
 * The content goes through WHOLE (#549). Reducing a multi-part turn to its
 * text before replaying it regenerated "what is in this picture" without the
 * picture, and refused a prompt that was only a picture; so the multi-part
 * cases assert the `image_url` parts survive, in their original order. The
 * same rule governs an edit: a string edit replaces the text and keeps the
 * attachments, and only a full parts array replaces them.
 */

const chat = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: unknown }[],
  /** Every `append` the hook made, which is how a replayed prompt leaves. */
  appended: [] as { role: string; content: unknown }[],
  /** The `SendOptions` that rode along with each `append`, in the same order. */
  appendedOptions: [] as unknown[],
  /** The list after the hook truncated it, i.e. what the replay is sent onto. */
  setTo: null as unknown,
  /** What the next `append` reports; 'failed' exercises the rollback path. */
  outcome: 'sent' as 'sent' | 'failed' | 'errored',
  composerDraft: null as unknown,
}));

vi.mock('@/lib/hooks/use-streaming-chat', () => ({
  useStreamingChat: () => ({
    messages: chat.messages,
    append: vi.fn(async (m: { role: string; content: unknown }, options?: unknown) => {
      chat.appended.push(m);
      chat.appendedOptions.push(options);
      return chat.outcome;
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

vi.mock('@/lib/stores/global-store', () => {
  const state = {
    pendingInitialMessage: null,
    setStreamingChatId: vi.fn(),
    streamingChatId: null,
    setChatId: vi.fn(),
    setBottomChatHeightHandler: vi.fn(),
    clearAttachments: vi.fn(),
    setAttachments: vi.fn(),
    setComposerDraft: vi.fn((draft: unknown) => { chat.composerDraft = draft; }),
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
  useClearConversation: () => ({ mutateAsync: vi.fn() }),
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
  chat.appendedOptions = [];
  chat.setTo = null;
  chat.outcome = 'sent';
  chat.composerDraft = null;
});

const PICTURE = { type: 'image_url', image_url: { url: 'https://example.test/a.png' } };
const SECOND_PICTURE = { type: 'image_url', image_url: { url: 'https://example.test/b.png' } };
const DOCUMENT = { type: 'file', file: { filename: 'notes.pdf', file_data: 'data:application/pdf;base64,AAAA' } };

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

  it('replays a multi-part user turn whole, picture included and in order', async () => {
    chat.messages = [
      {
        id: 'u1',
        role: 'user',
        content: [PICTURE, { type: 'text', text: 'what is in this picture' }],
      },
      { id: 'a1', role: 'assistant', content: 'a picture' },
    ];
    await mount();

    await act(async () => { await api.regenerateMessage('a1'); });

    expect(chat.appended).toEqual([{
      role: 'user',
      content: [PICTURE, { type: 'text', text: 'what is in this picture' }],
    }]);
  });

  it('regenerates an image-only prompt instead of refusing it', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [PICTURE] },
      { id: 'a1', role: 'assistant', content: 'a cat on a chair' },
    ];
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.regenerateMessage('a1'); });

    expect(outcome).toBe(true);
    expect(chat.appended).toEqual([{ role: 'user', content: [PICTURE] }]);
  });

  it('keeps every attachment of a turn with several pictures and a document', async () => {
    const content = [
      { type: 'text', text: 'compare these against the brief' },
      PICTURE,
      SECOND_PICTURE,
      DOCUMENT,
    ];
    chat.messages = [
      { id: 'u1', role: 'user', content },
      { id: 'a1', role: 'assistant', content: 'they differ in colour' },
    ];
    await mount();

    await act(async () => { await api.regenerateMessage('a1'); });

    expect(chat.appended).toEqual([{ role: 'user', content }]);
  });

  it('honours the current source and tool selection on the replay', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [PICTURE, { type: 'text', text: 'describe' }] },
      { id: 'a1', role: 'assistant', content: 'a picture' },
    ];
    await mount();

    await act(async () => {
      await api.regenerateMessage('a1', { mcpServerId: 'mcp-1', skillNames: ['summarise'] });
    });

    expect(chat.appended).toEqual([{ role: 'user', content: [PICTURE, { type: 'text', text: 'describe' }] }]);
    expect(chat.appendedOptions).toEqual([{ mcpServerId: 'mcp-1', skillNames: ['summarise'] }]);
  });

  it('refuses a user turn that has neither text nor attachments', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [] },
      { id: 'a1', role: 'assistant', content: 'nothing to say' },
    ];
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.regenerateMessage('a1'); });

    expect(outcome).toBe(false);
    expect(chat.appended).toEqual([]);
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

describe('editMessage', () => {
  it('replaces the text of a multi-part turn and keeps its attachments where they were', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [PICTURE, { type: 'text', text: 'what is this' }, DOCUMENT] },
      { id: 'a1', role: 'assistant', content: 'a picture' },
    ];
    await mount();

    await act(async () => { await api.editMessage('u1', 'what breed is this'); });

    expect(chat.appended).toEqual([{
      role: 'user',
      content: [PICTURE, { type: 'text', text: 'what breed is this' }, DOCUMENT],
    }]);
    expect(chat.setTo).toEqual([]);
  });

  it('adds text to an image-only turn after its picture', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [PICTURE] },
      { id: 'a1', role: 'assistant', content: 'a picture' },
    ];
    await mount();

    await act(async () => { await api.editMessage('u1', 'is this a cat'); });

    expect(chat.appended).toEqual([{
      role: 'user',
      content: [PICTURE, { type: 'text', text: 'is this a cat' }],
    }]);
  });

  it('sends a plain string when the original was plain text', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: 'first question' },
      { id: 'a1', role: 'assistant', content: 'first answer' },
    ];
    await mount();

    await act(async () => { await api.editMessage('u1', 'better question'); });

    expect(chat.appended).toEqual([{ role: 'user', content: 'better question' }]);
  });

  it('sends a full parts array verbatim, which is how an attachment is removed', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', content: [PICTURE, SECOND_PICTURE, { type: 'text', text: 'compare' }] },
      { id: 'a1', role: 'assistant', content: 'they differ' },
    ];
    await mount();

    const withoutSecond = [PICTURE, { type: 'text', text: 'describe' }];
    await act(async () => { await api.editMessage('u1', withoutSecond); });

    expect(chat.appended).toEqual([{ role: 'user', content: withoutSecond }]);
  });

  it('restores the original turn, attachments included, when the send fails', async () => {
    const original = { id: 'u1', role: 'user', content: [PICTURE, { type: 'text', text: 'what is this' }] };
    chat.messages = [original, { id: 'a1', role: 'assistant', content: 'a picture' }];
    chat.outcome = 'failed';
    await mount();

    let outcome: boolean | undefined;
    await act(async () => { outcome = await api.editMessage('u1', 'what breed is this'); });

    expect(outcome).toBe(false);
    // The thread is put back exactly as it was, so the picture is not orphaned.
    expect(chat.setTo).toEqual(chat.messages);
    // The composer gets the text back — the only part it can show.
    expect(chat.composerDraft).toMatchObject({ text: 'what breed is this', target: 'c1' });
  });
});
