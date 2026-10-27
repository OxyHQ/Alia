import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Awaited host tools from the SDK's side (`docs/agent-embedding.md` §2): the model waits for this
 * client's answer within the same turn, so the answer is POSTed at once, on the turn's
 * `host-results` route, through the authenticated API with the app assertion — while the turn's
 * stream is still open — and never queued for the next request. Also the per-turn
 * `personalization: false` switch, read from the host at send time.
 */

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const harness = vi.hoisted(() => ({
  requests: [] as Recorded[],
  /** Each chat request's frames; a function frame waits on that predicate before continuing. */
  turns: [] as (string | (() => boolean))[][],
  failAnswers: false,
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useAppAssertion: () => ({
    getAppAssertion: async () => 'astro-assertion',
    getAppAssertionHeaders: async () => ({ 'X-Oxy-App-Assertion': 'astro-assertion' }),
  }),
  useOxy: () => ({
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: ({ baseURL }: { baseURL: string }) => ({
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async (config: {
            method: string;
            url: string;
            headers?: Record<string, string>;
            body?: string;
          }) => {
            harness.requests.push({
              method: config.method,
              url: `${baseURL}|${config.url}`,
              headers: config.headers ?? {},
              body: config.body ? JSON.parse(config.body) : {},
            });
            if (config.url.includes('/host-results')) {
              if (harness.failAnswers) {
                return new Response(
                  JSON.stringify({ error: { code: 'turn_control_unavailable' } }),
                  {
                    status: 503,
                  },
                );
              }
              return new Response(JSON.stringify({ state: 'answered' }), { status: 200 });
            }
            const frames = harness.turns.shift() ?? [];
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              async start(controller) {
                for (const frame of frames) {
                  if (typeof frame === 'function') {
                    const deadline = Date.now() + 2_000;
                    while (!frame() && Date.now() < deadline) {
                      await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                    continue;
                  }
                  controller.enqueue(encoder.encode(frame));
                }
                controller.close();
              },
            });
            return { ok: true, status: 200, statusText: '', body };
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
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let stream: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe({ options }: { options: Parameters<typeof useConversationStream>[0] }) {
  stream = useConversationStream(options);
  return null;
}

async function mount(
  options: Parameters<typeof useConversationStream>[0],
  host: AliaRuntimeHost = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider apiUrl="http://api.test" host={host} app="astro">
          <Probe options={options} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

async function send(text = 'what is on this tab?') {
  await act(async () => {
    await stream.append({ role: 'user', content: text });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const frame = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
const content = (text: string) => frame({ choices: [{ index: 0, delta: { content: text } }] });
const done = 'data: [DONE]\n\n';
const chatRequests = () => harness.requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
const answers = () => harness.requests.filter((r) => r.url.includes('/host-results'));
const turnIdOf = (index: number) => chatRequests()[index]?.body.turnId as string;

function readTab(execute: AliaHostTools['execute'], extra: Partial<AliaHostTools> = {}) {
  return {
    definitions: [
      {
        name: 'read_tab',
        description: 'The text of the open tab.',
        inputSchema: { type: 'object' },
        awaitsResult: true,
      },
      { name: 'open_tab', description: 'Open a tab.', inputSchema: { type: 'object' } },
    ],
    execute,
    ...extra,
  } satisfies AliaHostTools;
}

beforeEach(() => {
  harness.requests.length = 0;
  harness.turns.length = 0;
  harness.failAnswers = false;
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('an awaited host action', () => {
  it('is answered at once, on the turn’s route, while the turn still streams', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'applied' as const,
      detail: 'Read the tab',
      result: { title: 'Docs', text: 'Hello' },
    }));
    const action = (turnId: string) =>
      frame(
        {
          eventVersion: 1,
          toolCallId: 'call_1',
          app: 'astro',
          name: 'read_tab',
          input: {},
          awaitsResult: true,
          turnId,
        },
        'alia.host_action',
      );
    let turnId = '';
    harness.turns.push([]);
    const turn = harness.turns[0] as (string | (() => boolean))[];
    turn.push(
      () => {
        turnId = turnIdOf(0) ?? '';
        turn.splice(1, 0, action(turnId));
        return true;
      },
      // The server would hold the stream until the answer arrived.
      () => answers().length > 0,
      content('The tab says Hello.'),
      done,
    );
    await mount({ conversationId: 'c1', hostTools: readTab(execute) });
    await send();

    expect(execute).toHaveBeenCalledTimes(1);
    const [answer] = answers();
    expect(answer).toMatchObject({
      method: 'POST',
      url: `http://api.test|/v1/chat/turns/${turnId}/host-results`,
      body: {
        toolCallId: 'call_1',
        outcome: 'applied',
        detail: 'Read the tab',
        result: { title: 'Docs', text: 'Hello' },
      },
    });
    expect(answer?.headers['X-Oxy-App-Assertion']).toBe('astro-assertion');
    expect(answers()).toHaveLength(1);
    expect(stream.messages.at(-1)?.content).toBe('The tab says Hello.');

    // Never queued for the next request.
    harness.turns.push([content('ok'), done]);
    await send('thanks');
    expect(chatRequests()[1]?.body.host).toEqual(expect.objectContaining({ app: 'astro' }));
    expect(chatRequests()[1]?.body.host).not.toHaveProperty('outcomes');
  });

  it('declares `awaitsResult` only for the tools that await', async () => {
    harness.turns.push([content('hi'), done]);
    await mount({ conversationId: 'c1', hostTools: readTab(vi.fn()) });
    await send();
    expect(chatRequests()[0]?.body.host).toEqual({
      app: 'astro',
      version: 1,
      tools: [
        {
          name: 'read_tab',
          description: 'The text of the open tab.',
          inputSchema: { type: 'object' },
          awaitsResult: true,
        },
        { name: 'open_tab', description: 'Open a tab.', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('reports an answer that could not be delivered to the host, once, without retrying', async () => {
    harness.failAnswers = true;
    const execute = vi.fn(async () => ({ outcome: 'applied' as const, result: 'text' }));
    const onUndelivered = vi.fn();
    harness.turns.push([]);
    const turn = harness.turns[0] as (string | (() => boolean))[];
    const action = (turnId: string, toolCallId: string) =>
      frame(
        {
          eventVersion: 1,
          toolCallId,
          app: 'astro',
          name: 'read_tab',
          input: {},
          awaitsResult: true,
          turnId,
        },
        'alia.host_action',
      );
    turn.push(
      () => {
        const id = turnIdOf(0) ?? '';
        // The same frame twice: still one execution and one attempt.
        turn.splice(1, 0, action(id, 'call_9'), action(id, 'call_9'));
        return true;
      },
      () => onUndelivered.mock.calls.length > 0,
      content('The app did not answer.'),
      done,
    );
    await mount({ conversationId: 'c1', hostTools: readTab(execute, { onUndelivered }) });
    await send();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(answers()).toHaveLength(1);
    expect(onUndelivered).toHaveBeenCalledTimes(1);
    expect(onUndelivered.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: 'call_9',
      awaitsResult: true,
    });
  });

  it('sends a result over the bound as a failure the model can read', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'applied' as const,
      result: 'x'.repeat(100_001),
    }));
    harness.turns.push([]);
    const turn = harness.turns[0] as (string | (() => boolean))[];
    turn.push(
      () => {
        turn.splice(
          1,
          0,
          frame(
            {
              eventVersion: 1,
              toolCallId: 'call_2',
              app: 'astro',
              name: 'read_tab',
              input: {},
              awaitsResult: true,
              turnId: turnIdOf(0),
            },
            'alia.host_action',
          ),
        );
        return true;
      },
      () => answers().length > 0,
      done,
    );
    await mount({ conversationId: 'c1', hostTools: readTab(execute) });
    await send();
    expect(answers()[0]?.body).toEqual({
      toolCallId: 'call_2',
      outcome: 'failed',
      detail: 'The result was too large to send.',
    });
  });
});

describe('personalization for one turn', () => {
  it('sends `personalization: false` when the host turns it off, and nothing otherwise', async () => {
    let personalization: false | undefined = false;
    const host: AliaRuntimeHost = { turnRequest: () => ({ personalization }) };
    harness.turns.push([content('a'), done], [content('b'), done]);
    await mount({ conversationId: 'c1' }, host);
    await send('first');
    personalization = undefined;
    await send('second');
    expect(chatRequests()[0]?.body.personalization).toBe(false);
    expect(chatRequests()[1]?.body).not.toHaveProperty('personalization');
  });
});
