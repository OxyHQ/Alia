import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two turns that overlap in time: Stop and a new send, a conversation left
 * mid-stream, Stop while the device info is still being collected.
 *
 * A turn's `finally` runs LATE (after its stream rejects), so everything it
 * does to shared state — the abort ref, `isLoading` — must be done only if the
 * turn still owns it.
 */

const harness = vi.hoisted(() => ({
  streams: [] as {
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    signal: AbortSignal | undefined;
  }[],
  conversationId: 'c1' as string | undefined,
}));

const stream = vi.hoisted(() => ({
  fetch: async (_url: string, init: { signal?: AbortSignal }) => {
    const open: (typeof harness.streams)[number] = { controller: null, signal: init.signal };
    harness.streams.push(open);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        open.controller = controller;
      },
    });
    init.signal?.addEventListener('abort', () => {
      try {
        open.controller?.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      } catch {
        /* already closed */
      }
    });
    return { ok: true, status: 200, body };
  },
}));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
  useOxy: () => ({
    user: null,
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          requestAuthenticatedResponse: (config: { url: string }) =>
            stream.fetch(config.url, config as never),
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host: AliaRuntimeHost = {};
let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Probe() {
  api = useConversationStream({ conversationId: harness.conversationId });
  return null;
}

const tree = () => (
  <QueryClientProvider client={client}>
    <AliaRuntimeProvider apiUrl="http://test.invalid" host={host}>
      <Probe />
    </AliaRuntimeProvider>
  </QueryClientProvider>
);

async function mount() {
  await act(async () => {
    renderer = create(tree());
  });
}

const wait = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Start a turn without awaiting it; the stream stays open. */
async function begin(text: string): Promise<{ outcome: Promise<string> }> {
  let outcome!: Promise<string>;
  act(() => {
    outcome = api.append({ role: 'user', content: text });
  });
  await wait();
  return { outcome };
}

const encoder = new TextEncoder();
const contentFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

beforeEach(() => {
  harness.streams.length = 0;
  harness.conversationId = 'c1';
  host.deviceInfo = undefined;
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('overlapping turns', () => {
  it('an old turn that ends after Stop and a new send does not idle the new one', async () => {
    await mount();
    const { outcome: first } = await begin('one');
    await act(async () => {
      api.stop();
    });
    const { outcome: second } = await begin('two');
    expect(await first).toBe('aborted');
    await wait();

    // The first turn's `finally` has run: the second is still streaming.
    expect(api.isLoading).toBe(true);
    expect(harness.streams[1].signal?.aborted).toBe(false);

    // And Stop still reaches it, because the old turn did not clear the ref.
    await act(async () => {
      api.stop();
    });
    expect(await second).toBe('aborted');
    expect(harness.streams[1].signal?.aborted).toBe(true);
  });

  it('an error frame cuts its own request', async () => {
    await mount();
    const { outcome } = await begin('one');
    await act(async () => {
      harness.streams[0].controller?.enqueue(
        encoder.encode(`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`),
      );
    });
    await outcome;
    expect(harness.streams[0].signal?.aborted).toBe(true);
    expect(api.isLoading).toBe(false);
  });
});

describe('leaving the conversation mid-stream', () => {
  it('cuts the stream and idles the screen', async () => {
    await mount();
    const { outcome } = await begin('one');
    await act(async () => {
      harness.streams[0].controller?.enqueue(encoder.encode(contentFrame('half')));
    });

    harness.conversationId = 'c2';
    await act(async () => {
      renderer?.update(tree());
    });
    await wait(80);

    expect(await outcome).toBe('aborted');
    expect(harness.streams[0].signal?.aborted).toBe(true);
    expect(api.isLoading).toBe(false);
  });

  it('keeps the stream when a new chat is given its id', async () => {
    harness.conversationId = undefined;
    await mount();
    await begin('one');
    harness.conversationId = 'c-new';
    await act(async () => {
      renderer?.update(tree());
    });
    expect(harness.streams[0].signal?.aborted).toBe(false);
    expect(api.isLoading).toBe(true);
  });
});

describe('Stop while the device info is collected', () => {
  it('cancels the send before any request is made', async () => {
    let release!: (info: undefined) => void;
    host.deviceInfo = () =>
      new Promise((resolve) => {
        release = resolve as (info: undefined) => void;
      });
    await mount();
    const { outcome } = await begin('one');
    await act(async () => {
      api.stop();
    });
    await act(async () => {
      release(undefined);
    });
    expect(await outcome).toBe('aborted');
    expect(harness.streams).toHaveLength(0);
    expect(api.isLoading).toBe(false);
    expect(api.messages.at(-1)).toMatchObject({ turnOutcome: 'cancelled' });
  });
});
