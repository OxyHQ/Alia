import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stream of ADR 0020 (`docs/agent-embedding.md` §2, §4, §5), from the SDK's side and over a
 * mocked transport: a consulted agent's reply streams into its own message; a host action is
 * performed once and its outcome rides the next request (and survives a request that never got
 * through); a feature gate's refusal reaches the host's upsell.
 */

type Reply = { status: number; frames: string[] } | { throws: Error };

const harness = vi.hoisted(() => ({
  requests: [] as { body: Record<string, unknown> }[],
  replies: [] as Reply[],
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          requestAuthenticatedResponse: async (config: { body: string }) => {
            harness.requests.push({ body: JSON.parse(config.body) });
            const reply = harness.replies.shift() ?? { status: 200, frames: [] };
            if ('throws' in reply) throw reply.throws;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of reply.frames) controller.enqueue(encoder.encode(frame));
                controller.close();
              },
            });
            return { ok: reply.status < 400, status: reply.status, statusText: '', body };
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import type { AliaHostTools } from '../../src/runtime/host-tools';
import type { Message } from '../../src/runtime/types';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = { onFeatureLocked: vi.fn() } satisfies AliaRuntimeHost;

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe({ options }: { options: Parameters<typeof useConversationStream>[0] }) {
  api = useConversationStream(options);
  return null;
}

async function mount(
  options: Parameters<typeof useConversationStream>[0] = {},
  app: string | undefined = undefined,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider apiUrl="http://api.test" host={host} app={app}>
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
const consult = (event: string, payload: Record<string, unknown>) =>
  frame({ eventVersion: 1, consultId: 'k1', ...payload }, `alia.${event}`);
/** The outcomes the `index`-th request carried in its `host` member. */
const outcomesSent = (index: number): unknown =>
  (harness.requests[index]?.body.host as { outcomes?: unknown } | undefined)?.outcomes;
const SINDI = { id: 'sindi', name: 'Sindi', handle: 'sindibot', color: 'teal' };

async function send(text = 'hello') {
  await act(async () => {
    await api.append({ role: 'user', content: text });
  });
  // Let a host action's `execute` settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  harness.requests.length = 0;
  harness.replies.length = 0;
  host.onFeatureLocked.mockClear();
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('a consultation', () => {
  it('streams into its own message, above the lead’s reply, under the agent’s identity', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        consult('agent_start', { agent: SINDI, task: 'find flats' }),
        consult('agent_delta', { content: 'Two ' }),
        consult('agent_tool', {
          phase: 'call',
          toolCallId: 't1',
          name: 'oxy_homiio__searchListings',
          input: { city: 'Barcelona' },
        }),
        consult('agent_tool', {
          phase: 'result',
          toolCallId: 't1',
          name: 'oxy_homiio__searchListings',
          output: { listings: [1, 2] },
        }),
        consult('agent_delta', { content: 'flats.' }),
        consult('agent_end', { status: 'completed' }),
        content('Sindi found two.'),
        done,
      ],
    });
    await mount({ conversationId: 'c1' });
    await send();

    const [, agent, reply] = api.messages as [Message, Message, Message];
    expect(agent.agentInfo).toEqual(SINDI);
    expect(agent.content).toBe('Two flats.');
    expect(agent.isStreaming).toBe(false);
    expect(agent.turnOutcome).toBe('completed');
    expect(agent.toolInvocations).toEqual([
      {
        toolCallId: 't1',
        toolName: 'oxy_homiio__searchListings',
        state: 'result',
        args: { city: 'Barcelona' },
        result: { listings: [1, 2] },
      },
    ]);
    // Named as the server stores it: `<reply>-agent-<n>`, n the order of its start.
    expect(agent.id).toBe(`${reply.id}-agent-0`);
    expect(reply.content).toBe('Sindi found two.');
  });

  it('is settled with the turn when the stream ends before its end frame', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        consult('agent_start', { agent: SINDI }),
        consult('agent_delta', { content: 'Hi' }),
        done,
      ],
    });
    await mount({ conversationId: 'c1' });
    await send();

    const agent = api.messages.find((m) => m.agentInfo);
    expect(agent?.isStreaming).toBe(false);
    expect(agent?.content).toBe('Hi');
  });

  it('drops a malformed frame whole, and the retired `alia.agent` frame is nothing', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        frame({ eventVersion: 1, agentId: 'x', agentName: 'X', content: 'old' }, 'alia.agent'),
        frame({ eventVersion: 2, consultId: 'k1', agent: SINDI }, 'alia.agent_start'),
        frame({ eventVersion: 1, consultId: 'k1', agent: { id: 'no-name' } }, 'alia.agent_start'),
        content('Just me.'),
        done,
      ],
    });
    await mount({ conversationId: 'c1' });
    await send();

    expect(api.messages.some((m) => m.agentInfo)).toBe(false);
    expect(api.messages.at(-1)?.content).toBe('Just me.');
  });
});

describe("the chat's app", () => {
  it('rides every turn, with no host tools an empty list, so it labels a conversation it starts', async () => {
    harness.replies.push({ status: 200, frames: [content('Hola.'), done] });
    await mount({ conversationId: 'c1' }, 'mercaria');
    await send('zapatos');
    expect(harness.requests[0]?.body.host).toEqual({ app: 'mercaria', version: 1, tools: [] });
  });

  it("is absent from Alia's own chat", async () => {
    harness.replies.push({ status: 200, frames: [content('Hola.'), done] });
    await mount({ conversationId: 'c1' });
    await send('hola');
    expect(harness.requests[0]?.body).not.toHaveProperty('host');
  });
});

describe('host tools', () => {
  const action = (toolCallId: string) =>
    frame(
      { eventVersion: 1, toolCallId, app: 'homiio', name: 'apply_search', input: { city: 'BCN' } },
      'alia.host_action',
    );
  const tools = (execute: AliaHostTools['execute']): AliaHostTools => ({
    definitions: [
      { name: 'apply_search', description: 'Apply a search', inputSchema: { type: 'object' } },
    ],
    execute,
  });

  it('declares them, performs an action once, and sends its outcome with the next request', async () => {
    const execute = vi.fn(async () => ({ outcome: 'applied' as const, detail: '12 results' }));
    harness.replies.push(
      { status: 200, frames: [action('call_1'), action('call_1'), content('Done.'), done] },
      { status: 200, frames: [content('Ok.'), done] },
      { status: 200, frames: [content('Again.'), done] },
    );
    await mount({ conversationId: 'c1', hostTools: tools(execute) }, 'homiio');
    await send('search');

    expect(harness.requests[0]?.body.host).toEqual({
      app: 'homiio',
      version: 1,
      tools: [
        { name: 'apply_search', description: 'Apply a search', inputSchema: { type: 'object' } },
      ],
    });
    // The frame came twice; the effect happened once.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      toolCallId: 'call_1',
      app: 'homiio',
      name: 'apply_search',
      input: { city: 'BCN' },
    });

    await send('next');
    expect(outcomesSent(1)).toEqual([
      { toolCallId: 'call_1', outcome: 'applied', detail: '12 results' },
    ]);

    // Delivered: the request after that one carries it no more.
    await send('and then');
    expect(outcomesSent(2)).toBeUndefined();
  });

  it('keeps an outcome for the next request when the one that carried it never got through', async () => {
    const execute = vi.fn(async () => ({ outcome: 'stale' as const }));
    harness.replies.push(
      { status: 200, frames: [action('call_2'), content('Done.'), done] },
      { throws: new Error('offline') },
      { status: 200, frames: [content('Back.'), done] },
    );
    await mount({ conversationId: 'c1', hostTools: tools(execute) }, 'homiio');
    await send('search');
    await send('lost');
    await send('retry');

    expect(outcomesSent(1)).toEqual([{ toolCallId: 'call_2', outcome: 'stale' }]);
    expect(outcomesSent(2)).toEqual([{ toolCallId: 'call_2', outcome: 'stale' }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('answers an undeclared tool, or an executor that throws, without guessing', async () => {
    const execute = vi.fn(async () => {
      throw new Error('map not ready');
    });
    harness.replies.push(
      {
        status: 200,
        frames: [
          action('call_3'),
          frame(
            { eventVersion: 1, toolCallId: 'call_4', app: 'homiio', name: 'nope', input: {} },
            'alia.host_action',
          ),
          content('Done.'),
          done,
        ],
      },
      { status: 200, frames: [content('Ok.'), done] },
    );
    await mount({ conversationId: 'c1', hostTools: tools(execute) }, 'homiio');
    await send('search');
    await send('next');

    expect(outcomesSent(1)).toEqual(
      expect.arrayContaining([
        { toolCallId: 'call_4', outcome: 'rejected', detail: 'Unknown tool "nope".' },
        { toolCallId: 'call_3', outcome: 'failed', detail: 'map not ready' },
      ]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sends no `host` from a surface that declares none', async () => {
    harness.replies.push({ status: 200, frames: [content('Hi.'), done] });
    await mount({ conversationId: 'c1' });
    await send();
    expect(harness.requests[0]?.body).not.toHaveProperty('host');
  });
});

describe('a feature gate’s refusal', () => {
  it('in the stream reaches the host’s upsell and hands the words back', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        frame({
          error: {
            code: 'feature_entitlement_required',
            feature: 'attachments.documents',
            retryable: false,
          },
        }),
      ],
    });
    await mount({ conversationId: 'c1' });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await api.append({ role: 'user', content: 'read my contract' });
    });

    expect(host.onFeatureLocked).toHaveBeenCalledWith('attachments.documents');
    // Rolled back, as a usage limit is: the composer gets its draft back, no failed card.
    expect(outcome).toBe('failed');
    expect(api.messages).toEqual([]);
    expect(api.failedTurn).toBeNull();
  });

  it('before the stream reaches the host’s upsell too', async () => {
    harness.replies.push({
      status: 403,
      frames: [
        JSON.stringify({
          error: { code: 'feature_entitlement_required', feature: 'attachments.images' },
        }),
      ],
    });
    await mount({ conversationId: 'c1' });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await api.append({ role: 'user', content: 'look' });
    });

    expect(host.onFeatureLocked).toHaveBeenCalledWith('attachments.images');
    expect(outcome).toBe('failed');
  });
});
