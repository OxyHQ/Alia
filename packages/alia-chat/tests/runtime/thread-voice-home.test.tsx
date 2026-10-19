import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';

/**
 * Where a voice call lives: the same rule for every surface, because it is one function.
 *
 * `ensureConversation` is what the sheet, the screen and the Alia app hand the voice launcher as
 * `resolveConversation`. With a conversation open the call lives in it and nothing is created;
 * on a new-chat screen the conversation is created now and shown, so the transcript has a home.
 */

const created = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));

vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: [],
    append: vi.fn(async () => 'sent'),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
    setMessages: vi.fn(),
    stop: vi.fn(),
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: vi.fn(),
    failedTurn: null,
    retryFailedTurn: vi.fn(),
    clearFailedTurn: vi.fn(),
    turnOptionsOf: vi.fn(),
  }),
}));
vi.mock('../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({
    mutateAsync: vi.fn(async (params: unknown) => {
      created.calls.push(params);
      if (created.fail) throw new Error('offline');
      return { id: 'made' };
    }),
  }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useClearConversation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({ user: null, isAuthenticated: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../src/runtime/attachment-utils', () => ({
  buildMessageContent: (text: string) => text,
}));

import { useConversationThread } from '../../src/runtime/use-conversation-thread';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useConversationThread>;
const host = { openConversation: vi.fn(), closeConversation: vi.fn() } satisfies AliaRuntimeHost;

function Probe({ conversationId, agentId }: { conversationId?: string; agentId?: string }) {
  api = useConversationThread({ conversationId, agentId });
  return null;
}

async function mount(props: { conversationId?: string; agentId?: string }) {
  const client = new QueryClient();
  await act(async () => {
    create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider host={host}>
          <Probe {...props} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  created.calls = [];
  created.fail = false;
  host.openConversation.mockReset();
  host.closeConversation.mockReset();
});

describe('the conversation a voice call lives in', () => {
  it('is the open one, and nothing is created', async () => {
    await mount({ conversationId: 'c1' });
    await expect(api.ensureConversation()).resolves.toBe('c1');

    expect(created.calls).toEqual([]);
    expect(host.openConversation).not.toHaveBeenCalled();
  });

  it('is a new one on a new-chat screen: created, then shown', async () => {
    await mount({});
    await expect(api.ensureConversation()).resolves.toBe('made');

    expect(created.calls).toHaveLength(1);
    expect(host.openConversation).toHaveBeenCalledWith('made');
  });

  it("is a new stretch of the agent's thread when the screen is an agent's", async () => {
    await mount({ agentId: 'agent-1' });
    await api.ensureConversation();

    expect(created.calls).toEqual([{ agentId: 'agent-1' }]);
  });

  it('is nothing when the conversation could not be created, and nothing is shown', async () => {
    created.fail = true;
    await mount({});
    await expect(api.ensureConversation()).resolves.toBeUndefined();

    expect(host.openConversation).not.toHaveBeenCalled();
  });
});
