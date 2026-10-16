import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the stream tells the host around it, and what it asks of it.
 *
 * The Alia app and the sheet mount the SAME stream; everything that differs between them is the
 * `AliaRuntimeHost` they pass. So the contract is pinned from the stream's side: which request it
 * sends (the host's modes, device info, client context, the agent), and which callbacks a frame
 * reaches. The app's own implementations of those callbacks are pinned in the app.
 */

const harness = vi.hoisted(() => ({
  requests: [] as { url: string; headers: Record<string, string>; body: Record<string, unknown> }[],
  responses: [] as string[][],
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: ({ baseURL }: { baseURL: string }) => ({
        client: {
          requestAuthenticatedResponse: async (config: {
            url: string;
            headers: Record<string, string>;
            body: string;
          }) => {
            harness.requests.push({
              url: `${baseURL}|${config.url}`,
              headers: config.headers,
              body: JSON.parse(config.body),
            });
            const frames = harness.responses.shift() ?? [];
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
              },
            });
            return { ok: true, status: 200, body };
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { aliaQueryKeys } from '../../src/runtime/query-keys';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';
import type { Conversation, ConversationsInfiniteData } from '../../src/runtime/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = {
  deviceInfo: vi.fn(async () => ({ platformOS: 'test' })),
  turnRequest: vi.fn(() => ({ webSearch: false, deepResearch: true })),
  onOutput: vi.fn(),
  onToolResult: vi.fn(),
  onArtifact: vi.fn(),
  onContext: vi.fn(),
  onAgentTurn: vi.fn(),
  onTurnPreview: vi.fn(),
} satisfies AliaRuntimeHost;

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;
let client: QueryClient;

function Probe({ options }: { options: Parameters<typeof useConversationStream>[0] }) {
  api = useConversationStream(options);
  return null;
}

async function mount(options: Parameters<typeof useConversationStream>[0] = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider apiUrl="http://api.test" host={host}>
          <Probe options={options} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

const frame = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
const content = (text: string) => frame({ choices: [{ index: 0, delta: { content: text } }] });
const done = 'data: [DONE]\n\n';

beforeEach(() => {
  harness.requests.length = 0;
  harness.responses.length = 0;
  for (const fn of Object.values(host)) fn.mockClear();
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('the request a turn makes', () => {
  it('goes to the product API with the conversation, the agent, the level and the host’s modes', async () => {
    harness.responses.push([content('hi'), done]);
    await mount({ conversationId: 'c1', agentId: 'a1', model: 'high' });
    await act(async () => {
      await api.append(
        { role: 'user', content: 'hello' },
        { mcpServerId: 'm1', skillNames: ['s'] },
      );
    });

    const [request] = harness.requests;
    expect(request?.url).toBe('http://api.test|/v1/chat/completions');
    expect(request?.headers['X-Device-Info']).toBe(JSON.stringify({ platformOS: 'test' }));
    expect(request?.body).toMatchObject({
      stream: true,
      conversationId: 'c1',
      agentId: 'a1',
      model: 'high',
      // Only OFF is sent for web search; the other modes only when on.
      webSearch: false,
      deepResearch: true,
      mcpServerId: 'm1',
      skillIds: ['s'],
    });
  });

  it('leads with the host’s client context as a system message, and never stores it as a turn', async () => {
    harness.responses.push([content('hi'), done]);
    await mount({ clientContext: 'The user is reading note #42.' });
    await act(async () => {
      await api.append({ role: 'user', content: 'summarise' });
    });

    const messages = harness.requests[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: 'The user is reading note #42.',
    });
    expect(api.messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('what a frame reaches', () => {
  it('previews the agent’s row twice per turn: your line on send, her answer when it settles', async () => {
    harness.responses.push([content('Hel'), content('lo'), content(' there'), done]);
    await mount({ agentId: 'a1' });
    await act(async () => {
      await api.append({ role: 'user', content: 'hi agent' });
    });

    expect(host.onTurnPreview.mock.calls).toEqual([
      ['a1', 'hi agent'],
      ['a1', 'Hello there'],
    ]);
  });

  it('ticks the host for real output only', async () => {
    harness.responses.push([content('a'), done]);
    await mount();
    await act(async () => {
      await api.append({ role: 'user', content: 'hi' });
    });
    expect(host.onOutput).toHaveBeenCalledTimes(1);
  });

  it('hands over tool results, and a generated file as an artifact that counts as output', async () => {
    harness.responses.push([
      frame(
        {
          tool_call_id: 't1',
          name: 'generateFile',
          output: { content: '# Title', filename: 'a.md' },
        },
        'alia.tool_result',
      ),
      done,
    ]);
    await mount();
    let outcome: string | undefined;
    await act(async () => {
      outcome = await api.append({ role: 'user', content: 'write it' });
    });

    expect(host.onToolResult).toHaveBeenCalledWith({
      toolCallId: 't1',
      name: 'generateFile',
      output: { content: '# Title', filename: 'a.md' },
    });
    expect(host.onArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', type: 'markdown', title: 'a.md' }),
    );
    // No sentence, but a durable artifact: the turn answered.
    expect(outcome).toBe('sent');
  });

  it('hands over the context window and a delegated agent’s run', async () => {
    harness.responses.push([
      content('ok'),
      frame({ conversationId: 'c9', used: 10 }, 'alia.context'),
      frame({ turnId: 'turn-1', agentId: 'a2' }, 'alia.agent_turn'),
      done,
    ]);
    await mount({ conversationId: 'c1' });
    await act(async () => {
      await api.append({ role: 'user', content: 'go' });
    });

    expect(host.onContext).toHaveBeenCalledWith('c9', { conversationId: 'c9', used: 10 });
    expect(host.onAgentTurn).toHaveBeenCalledWith({
      turnId: 'turn-1',
      agentId: 'a2',
      conversationId: 'c1',
    });
  });

  it('writes a new title into the cached conversation and its row in the list', async () => {
    const row = { id: 'c1', title: 'New chat' } as Conversation;
    harness.responses.push([
      content('hi'),
      frame({ conversationId: 'c1', title: 'Peru trip' }, 'alia.title'),
      done,
    ]);
    await mount({ conversationId: 'c1' });
    client.setQueryData(aliaQueryKeys.conversations.detail('c1'), row);
    client.setQueryData<ConversationsInfiniteData>(aliaQueryKeys.conversations.all, {
      pages: [{ conversations: [row], nextCursor: null, hasMore: false }],
      pageParams: [undefined],
    });
    await act(async () => {
      await api.append({ role: 'user', content: 'plan a trip' });
    });

    expect(client.getQueryData<Conversation>(aliaQueryKeys.conversations.detail('c1'))?.title).toBe(
      'Peru trip',
    );
    expect(
      client.getQueryData<ConversationsInfiniteData>(aliaQueryKeys.conversations.all)?.pages[0]
        ?.conversations[0]?.title,
    ).toBe('Peru trip');
    expect(api.conversationTitle).toBe('Peru trip');
  });
});
