import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `AliaRuntimeHost.onTurnEnd`: the host hears, once, that a turn it sent has stopped streaming —
 * however it stopped — and only while the conversation that sent it is still mounted.
 *
 * A host holds work back until the answer is written (an app that navigates away from its chat
 * waits for the turn's end). It must hear the end after Stop too, and must NOT hear it once its
 * surface has gone: what it held back went with it.
 */

const harness = vi.hoisted(() => ({
  /** The open stream's controller, to push frames and close on demand. */
  controller: null as ReadableStreamDefaultController<Uint8Array> | null,
  /** What the next request answers instead of an open stream. */
  next: null as null | { reject: Error } | { status: number; body: unknown },
}));

const stream = vi.hoisted(() => ({
  fetch: async (_url: string, init: { signal?: AbortSignal }) => {
    const next = harness.next;
    harness.next = null;
    if (next && 'reject' in next) throw next.reject;
    if (next) {
      const bytes = new TextEncoder().encode(JSON.stringify(next.body));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return { ok: false, status: next.status, statusText: 'Error', body };
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        harness.controller = controller;
      },
    });
    // A real fetch rejects with AbortError when its signal fires; so does this.
    init.signal?.addEventListener('abort', () => {
      try {
        harness.controller?.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      } catch {
        /* already closed */
      }
    });
    return { ok: true, status: 200, body };
  },
}));

vi.mock('@oxy.so/services/ui/client', () => ({
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

const onTurnEnd = vi.fn();
const host: AliaRuntimeHost = { onTurnEnd };

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  api = useConversationStream({ conversationId: 'c1' });
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider apiUrl="http://test.invalid" host={host}>
          <Probe />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const contentFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

/** Start a turn without awaiting it (see `stream-lifecycle.test.tsx`), and let it open. */
async function begin(): Promise<{ outcome: Promise<string> }> {
  let outcome!: Promise<string>;
  act(() => {
    outcome = api.append({ role: 'user', content: 'hello?' });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { outcome };
}

async function deliver(frame: string) {
  await act(async () => {
    harness.controller?.enqueue(new TextEncoder().encode(frame));
    await settle();
  });
}

beforeEach(() => {
  harness.controller = null;
  harness.next = null;
  onTurnEnd.mockClear();
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('onTurnEnd', () => {
  it('is called once when the answer has been written, not while it streams', async () => {
    await mount();
    const { outcome } = await begin();
    await deliver(contentFrame('The answer'));
    expect(onTurnEnd).not.toHaveBeenCalled();

    await act(async () => {
      harness.controller?.close();
      await settle();
    });

    expect(await outcome).toBe('sent');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('is called once after Stop: the answer it was waiting for is cancelled', async () => {
    await mount();
    const { outcome } = await begin();
    await deliver(contentFrame('Half of'));

    await act(async () => {
      api.stop();
      await settle();
    });

    expect(await outcome).toBe('aborted');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('is called once when the request fails', async () => {
    await mount();
    harness.next = { reject: new TypeError('Network request failed') };

    let outcome!: string;
    await act(async () => {
      outcome = await api.append({ role: 'user', content: 'hello?' });
    });

    expect(outcome).toBe('errored');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('is called once when the server refuses the turn before streaming', async () => {
    await mount();
    harness.next = {
      status: 503,
      body: { error: { code: 'upstream_unavailable', retryable: true, reference: 'ref-1' } },
    };

    let outcome!: string;
    await act(async () => {
      outcome = await api.append({ role: 'user', content: 'hello?' });
    });

    expect(outcome).toBe('errored');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('is never called for a turn whose conversation unmounted mid-stream', async () => {
    await mount();
    const { outcome } = await begin();
    await deliver(contentFrame('Half of'));

    await act(async () => renderer?.unmount());
    renderer = null;
    await act(async () => {
      harness.controller?.close();
      await settle();
    });

    expect(await outcome).toBe('sent');
    expect(onTurnEnd).not.toHaveBeenCalled();
  });
});
