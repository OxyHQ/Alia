import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeaChatViewProvider } from '../chatProvider';

/**
 * Stop and a new message while the old turn is still winding down, and what the saved history
 * keeps of a turn that did not finish.
 */

const world = vi.hoisted(() => ({
  streams: [] as (() => AsyncGenerator<unknown>)[],
  requests: [] as { messages: unknown[] }[],
  saved: [] as { messages: { role: string; tool_call_id?: string; tool_calls?: unknown }[] }[][],
  listeners: new Set<() => void>(),
  toolStarted: null as (() => void) | null,
  toolRelease: null as (() => void) | null,
}));

vi.mock('../logger', () => ({
  log: { debug() {}, info() {}, warn() {}, error() {} },
}));
vi.mock('../catalogue', () => ({
  fetchPickerCatalogue: async () => ({ groups: [], defaultLabel: '' }),
  resolveModelId: async () => undefined,
}));
vi.mock('../tools', () => ({
  fileTools: [],
  ToolExecutor: class {
    async getContext() {
      return {};
    }
    async execute() {
      world.toolStarted?.();
      await new Promise<void>((resolve) => {
        world.toolRelease = resolve;
      });
      return { success: true, result: 'ok' };
    }
  },
}));
vi.mock('../aliaChat', async () => ({
  ...(await vi.importActual<typeof import('../aliaChat')>('../aliaChat')),
  streamAliaChat: (options: { body: { messages: unknown[] } }) => {
    world.requests.push({ messages: structuredClone(options.body.messages) });
    const next = world.streams.shift();
    if (next === undefined) throw new Error('no stream scripted');
    return next();
  },
}));

async function* script(...events: unknown[]) {
  for (const event of events) yield event;
}
const toolCalls = (...ids: string[]) => ({
  type: 'tool_calls',
  deltas: ids.map((id, index) => ({
    index,
    id,
    function: { name: 'read_file', arguments: '{}' },
  })),
});

let posted: { type: string; [key: string]: unknown }[];
let handler: (data: unknown) => Promise<void>;

function makeProvider() {
  posted = [];
  const state = new Map<string, unknown>();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
      update: (key: string, value: unknown) => {
        state.set(key, value);
        world.saved.push(structuredClone(value) as never);
      },
    },
  };
  const auth = {
    onDidChangeSessions: () => ({ dispose: () => undefined }),
    getAccessToken: async () => 'token',
    createLinkedClient: () => ({
      fetch: globalThis.fetch,
      fetchOptional: globalThis.fetch,
      dispose() {},
    }),
    onSessionContextChange: (listener: () => void) => {
      world.listeners.add(listener);
      return () => world.listeners.delete(listener);
    },
    refreshToken: async () => false,
    getOxyServices: () => ({ users: { me: async () => ({ username: 'u' }) } }),
  };
  const provider = new CodeaChatViewProvider({} as never, context as never, auth as never);
  provider.resolveWebviewView(
    {
      webview: {
        options: {},
        html: '',
        postMessage: (message: never) => posted.push(message),
        onDidReceiveMessage: (fn: typeof handler) => {
          handler = fn;
        },
        asWebviewUri: (u: unknown) => u,
        cspSource: '',
      },
    } as never,
    {} as never,
    {} as never,
  );
  return provider;
}

const send = (message: string) => handler({ type: 'sendMessage', message, mode: 'ask' });
const lastSaved = () => world.saved.at(-1)?.[0].messages ?? [];

beforeEach(() => {
  world.listeners.clear();
  world.streams.length = 0;
  world.requests.length = 0;
  world.saved.length = 0;
  world.toolStarted = null;
  world.toolRelease = null;
});

describe('Stop, then a new message', () => {
  it('does not resume the old loop, and the old tool result precedes the new user message', async () => {
    makeProvider();
    let started!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      started = resolve;
    });
    world.toolStarted = started;
    world.streams.push(() => script(toolCalls('t1')));
    world.streams.push(() => script({ type: 'content', text: 'second answer' }));

    const first = send('one');
    await toolRunning;
    await handler({ type: 'stopGeneration' });
    const second = send('two');
    world.toolRelease?.();
    await first;
    await second;

    // Exactly one more request: the new turn's. The stopped loop did not stream again.
    expect(world.requests).toHaveLength(2);
    const roles = (world.requests[1].messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  });
});

describe('the history of a turn that did not finish', () => {
  it('answers the tool calls that were not run when stopped between tools', async () => {
    makeProvider();
    let started!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      started = resolve;
    });
    world.toolStarted = started;
    world.streams.push(() => script(toolCalls('a', 'b')));

    const first = send('one');
    await toolRunning;
    await handler({ type: 'stopGeneration' });
    world.toolRelease?.();
    await first;

    const toolIds = lastSaved()
      .filter((m) => m.role === 'tool')
      .map((m) => m.tool_call_id);
    expect(toolIds).toEqual(['a', 'b']);
  });
});

describe('the server’s stand-in', () => {
  it('is not retried when the server says it is not retryable', async () => {
    makeProvider();
    world.streams.push(() => script({ type: 'synthetic', text: 'no', retryable: false }));

    await send('one');

    expect(world.requests).toHaveLength(1);
    expect(posted.find((m) => m.type === 'error')).toMatchObject({ retryable: false });
  });

  it('is retried once when retryable', async () => {
    vi.useFakeTimers();
    try {
      makeProvider();
      world.streams.push(() => script({ type: 'synthetic', text: 'busy', retryable: true }));
      world.streams.push(() => script({ type: 'content', text: 'answer' }));
      const turn = send('one');
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(2500);
      await turn;
      expect(world.requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('account context', () => {
  it('never forwards a late tool result into the replacement account conversation', async () => {
    makeProvider();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    world.toolStarted = started;
    world.streams.push(() => script(toolCalls('old-tool')));
    const first = send('private old message');
    await running;
    for (const listener of world.listeners) listener();
    world.streams.push(() => script({ type: 'content', text: 'new account response' }));
    const second = send('new account message');
    world.toolRelease?.();
    await first;
    await second;
    expect(world.requests).toHaveLength(2);
    const messages = world.requests[1].messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages.at(-1)?.content).toContain('new account message');
    expect(posted.filter((m) => m.type === 'toolResult')).toHaveLength(0);
  });
});
