import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Turns that overlap in time (Stop, then a new message while the old turn is still winding down)
 * and what the history keeps of a turn that did not finish.
 */

const world = vi.hoisted(() => ({
  /** One scripted stream per request, in order. */
  streams: [] as ((signal: AbortSignal | undefined) => AsyncGenerator<unknown>)[],
  requests: [] as { messages: unknown[]; signal: AbortSignal | undefined }[],
}));

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('electron-store', () => ({
  default: class {
    get(key: string) {
      return key === 'apiBaseUrl'
        ? 'http://test.invalid'
        : key === 'enableTools'
          ? true
          : undefined;
    }
    set() {}
    delete() {}
  },
}));
vi.mock('../auth', () => ({
  currentAccessToken: () => 'token',
  linkedAliaClient: () => ({ fetch, dispose() {} }),
  onSessionContextChange: () => () => {},
}));
vi.mock('../catalogue', () => ({
  isModelId: () => false,
  loadCatalogue: async () => null,
  resolveModelId: async () => undefined,
}));
vi.mock('../alia-chat', async () => ({
  ...(await vi.importActual<typeof import('../alia-chat')>('../alia-chat')),
  streamAliaChat: (options: { body: { messages: unknown[] }; signal?: AbortSignal }) => {
    world.requests.push({
      messages: structuredClone(options.body.messages),
      signal: options.signal,
    });
    const next = world.streams.shift();
    if (next === undefined) throw new Error('no stream scripted');
    return next(options.signal);
  },
}));

const { ChatProvider } = await import('../chat');

const sent: { channel: string; data: unknown }[] = [];
const window = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: unknown) => sent.push({ channel, data }) },
};

/** A tool executor whose `readFile` the test settles by hand. */
function makeTools() {
  const gate: { release: () => void; started: Promise<void> } = {} as never;
  let started!: () => void;
  gate.started = new Promise((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return {
    gate,
    tools: {
      readFile: async () => {
        started();
        await waiting;
        return 'file contents';
      },
      closeBrowser: async () => 'Browser was not open',
      reset: () => {},
    },
  };
}

const toolCall = (id: string, name = 'read_file') => ({
  type: 'tool_calls',
  deltas: [{ index: 0, id, function: { name, arguments: '{"path":"a"}' } }],
});

async function* script(...events: unknown[]) {
  for (const event of events) yield event;
}

beforeEach(() => {
  world.streams.length = 0;
  world.requests.length = 0;
  sent.length = 0;
});

describe('Stop and a second turn', () => {
  it('lets the new turn run while the old one finishes its tool, and the old one does not end it', async () => {
    const { gate, tools } = makeTools();
    const chat = new ChatProvider(window as never, tools as never);

    // The first turn asks for a tool; Stop it while that tool runs.
    world.streams.push(() => script(toolCall('t1'), { type: 'finish', reason: 'tool_calls' }));
    world.streams.push(() =>
      script({ type: 'content', text: 'second answer' }, { type: 'finish', reason: 'stop' }),
    );

    const first = chat.handleMessage('one');
    await gate.started;
    chat.stop();
    const second = chat.handleMessage('two');
    // The second message is accepted at once, but waits for the first to wind down.
    expect(world.requests).toHaveLength(1);
    gate.release();
    await first;
    await second;

    expect(world.requests).toHaveLength(2);
    const history = world.requests[1].messages as { role: string; tool_call_id?: string }[];
    // The interrupted turn's tool result is in the history BEFORE the new user message.
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    // The second turn streamed to the renderer, and the first did not send its own `chat:end`
    // after the second began.
    const channels = sent.map((s) => s.channel);
    expect(channels.filter((c) => c === 'chat:stream')).toHaveLength(1);
    expect(channels.at(-1)).toBe('chat:end');
    expect(channels.filter((c) => c === 'chat:end')).toHaveLength(2);
  });

  it('ignores a second message sent in the same tick as the first', async () => {
    const chat = new ChatProvider(window as never, makeTools().tools as never);
    world.streams.push(() => script({ type: 'content', text: 'hi' }));
    await Promise.all([chat.handleMessage('one'), chat.handleMessage('two')]);
    expect(world.requests).toHaveLength(1);
  });
});

describe('the history of a turn that did not finish', () => {
  it('answers the tool calls that were not run when the turn is stopped between tools', async () => {
    const { gate, tools } = makeTools();
    const chat = new ChatProvider(window as never, tools as never);
    world.streams.push(() =>
      script({
        type: 'tool_calls',
        deltas: [
          { index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } },
          { index: 1, id: 'b', function: { name: 'read_file', arguments: '{}' } },
        ],
      }),
    );
    world.streams.push(() => script({ type: 'content', text: 'next' }));

    const first = chat.handleMessage('one');
    await gate.started;
    chat.stop();
    gate.release();
    await first;
    await chat.handleMessage('two');

    const history = world.requests[1].messages as { role: string; tool_call_id?: string }[];
    const toolIds = history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolIds).toEqual(['a', 'b']);
  });

  it('does not remember the tool calls of a synthetic stand-in', async () => {
    const chat = new ChatProvider(window as never, makeTools().tools as never);
    world.streams.push(() =>
      script(toolCall('t1'), { type: 'synthetic', text: 'busy', retryable: true }),
    );
    world.streams.push(() => script({ type: 'content', text: 'ok' }));

    await chat.handleMessage('one');
    await chat.handleMessage('two');

    const history = world.requests[1].messages as { role: string; tool_calls?: unknown }[];
    expect(history.some((m) => m.tool_calls !== undefined)).toBe(false);
  });
});
