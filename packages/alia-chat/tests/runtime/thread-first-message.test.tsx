import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hand-off of a first message, and the screen of a conversation that is not there.
 *
 * A conversation is made, then SHOWN, and the thread that opens sends the message queued for it.
 * Addressing it matters: a second open thread, empty and loading, must not take another
 * conversation's first message. If the send fails before the model is reached the conversation is
 * provably empty, so it is undone and the composer gets its words back.
 */

const world = vi.hoisted(() => ({
  appended: [] as { message: { role: string; content: unknown }; options: unknown }[],
  outcome: 'sent' as 'sent' | 'failed',
  deleted: [] as string[],
  detailError: null as Error | null,
}));

vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: [],
    append: async (message: { role: string; content: unknown }, options: unknown) => {
      world.appended.push({ message, options });
      return world.outcome;
    },
    isLoading: false,
    error: null,
    clearError: () => {},
    setMessages: () => {},
    stop: () => {},
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: () => {},
    failedTurn: null,
    retryFailedTurn: async () => 'sent',
    clearFailedTurn: () => {},
    turnOptionsOf: () => undefined,
  }),
}));
vi.mock('../../src/runtime/conversations', () => {
  class ConversationNotFoundError extends Error {
    readonly conversationId: string;
    constructor(conversationId: string) {
      super('Conversation not found');
      this.conversationId = conversationId;
    }
  }
  return {
    ConversationNotFoundError,
    useConversation: (id: string) => ({
      data: undefined,
      error: world.detailError ?? null,
      isLoading: false,
      isFetching: false,
      id,
    }),
    useCreateConversation: () => ({ mutateAsync: async () => ({ id: 'made' }) }),
    useDeleteConversation: () => ({
      mutateAsync: async (id: string) => {
        world.deleted.push(id);
      },
    }),
    useClearConversation: () => ({ mutateAsync: async () => {} }),
  };
});
vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({ user: null, isAuthenticated: true }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('../../src/runtime/attachment-utils', () => ({
  buildMessageContent: async (text: string) => ({ content: text, dropped: [] }),
}));

import { DEFAULT_LABELS } from '../../src/lib/labels';
import { useComposerDraftStore } from '../../src/runtime/composer-draft-store';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { ConversationNotFoundError } from '../../src/runtime/conversations';
import { useConversationStore } from '../../src/runtime/conversation-store';
import { useConversationThread } from '../../src/runtime/use-conversation-thread';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = { closeConversation: vi.fn() } satisfies AliaRuntimeHost;
let renderer: ReactTestRenderer | undefined;

function Probe({ conversationId }: { conversationId: string }) {
  useConversationThread({ conversationId });
  return null;
}

async function mount(conversationId: string) {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={new QueryClient()}>
        <AliaRuntimeProvider host={host}>
          <Probe conversationId={conversationId} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

const queue = (conversationId: string) =>
  useConversationStore.setState({
    pendingInitialMessage: {
      conversationId,
      content: 'first words',
      text: 'first words',
      attachments: [],
      mcpServerId: 'm1',
      skillNames: ['s'],
    },
  });

beforeEach(() => {
  world.appended = [];
  world.outcome = 'sent';
  world.deleted = [];
  world.detailError = null;
  host.closeConversation.mockReset();
  toast.error.mockReset();
  useConversationStore.setState({ pendingInitialMessage: null });
  useComposerDraftStore.setState({ account: null, drafts: {} });
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('the first message of a new conversation', () => {
  it('is sent once by the thread of the conversation it was queued for', async () => {
    queue('c1');
    await mount('c1');

    expect(world.appended).toEqual([
      {
        message: { role: 'user', content: 'first words' },
        options: { mcpServerId: 'm1', skillNames: ['s'] },
      },
    ]);
    expect(useConversationStore.getState().pendingInitialMessage).toBeNull();
  });

  it('is left alone by the thread of any other conversation', async () => {
    queue('c1');
    await mount('c2');

    expect(world.appended).toEqual([]);
    expect(useConversationStore.getState().pendingInitialMessage).not.toBeNull();
  });

  it('undoes the empty conversation and gives the words back when the send is refused', async () => {
    world.outcome = 'failed';
    queue('c1');
    await mount('c1');

    expect(world.deleted).toEqual(['c1']);
    expect(host.closeConversation).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().drafts['']).toMatchObject({
      text: 'first words',
      mcpServerId: 'm1',
      skillNames: ['s'],
    });
    expect(toast.error).toHaveBeenCalledWith(DEFAULT_LABELS.sendFailed);
  });
});

describe('a conversation that is not there', () => {
  it('is left: the host is told to show something else', async () => {
    world.detailError = new ConversationNotFoundError('gone');
    await mount('gone');

    expect(host.closeConversation).toHaveBeenCalledOnce();
  });
});
