import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starting a conversation with a first message: the one path for a new-chat screen, the sheet's
 * first turn and a screen that starts a chat from elsewhere.
 *
 * The message is queued for THE conversation that was made (not for whichever thread happens to be
 * empty), the host is told to show it, and a conversation that cannot be made hands the draft back.
 */

const created = vi.hoisted(() => ({ fail: false, calls: [] as unknown[] }));
vi.mock('../../src/runtime/conversations', () => ({
  useCreateConversation: () => ({
    mutateAsync: async (params: unknown) => {
      created.calls.push(params);
      if (created.fail) throw new Error('offline');
      return { id: 'made' };
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { useComposerDraftStore } from '../../src/runtime/composer-draft-store';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { useConversationStore } from '../../src/runtime/conversation-store';
import { useStartConversation } from '../../src/runtime/use-start-conversation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = { openConversation: vi.fn() } satisfies AliaRuntimeHost;
let start: ReturnType<typeof useStartConversation>;
let renderer: ReactTestRenderer | undefined;

function Probe({ agentId }: { agentId?: string }) {
  start = useStartConversation({ agentId });
  return null;
}

async function mount(agentId?: string) {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={new QueryClient()}>
        <AliaRuntimeProvider host={host}>
          <Probe agentId={agentId} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  created.fail = false;
  created.calls = [];
  host.openConversation.mockReset();
  useConversationStore.setState({ pendingInitialMessage: null });
  useComposerDraftStore.setState({ account: null, drafts: {} });
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('useStartConversation', () => {
  it('queues the message for the conversation it made, then shows that conversation', async () => {
    await mount('agent-1');
    await expect(
      start('plan my week', { options: { mcpServerId: 'm1', skillNames: ['brief'] } }),
    ).resolves.toBe(true);

    expect(created.calls).toEqual([{ agentId: 'agent-1' }]);
    expect(useConversationStore.getState().pendingInitialMessage).toMatchObject({
      conversationId: 'made',
      content: 'plan my week',
      text: 'plan my week',
      mcpServerId: 'm1',
      skillNames: ['brief'],
    });
    expect(host.openConversation).toHaveBeenCalledWith('made');
  });

  it('sends nothing for an empty message', async () => {
    await mount();
    await expect(start('   ')).resolves.toBe(false);

    expect(created.calls).toEqual([]);
    expect(useConversationStore.getState().pendingInitialMessage).toBeNull();
  });

  it('hands the draft back to its own composer when the conversation cannot be made', async () => {
    created.fail = true;
    await mount();
    await expect(
      start('lost words', {
        draft: 'surface:automations',
        options: { mcpServerId: 'm1', skillNames: ['s'] },
      }),
    ).resolves.toBe(false);

    expect(useConversationStore.getState().pendingInitialMessage).toBeNull();
    expect(host.openConversation).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().drafts['surface:automations']).toMatchObject({
      text: 'lost words',
      mcpServerId: 'm1',
      skillNames: ['s'],
    });
  });
});
