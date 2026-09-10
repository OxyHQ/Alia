import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lifecycle the streaming hook stamps on the assistant message.
 *
 * `turnLifecycle` (lib/thought-utils.ts) reads a turn's state off two fields
 * the hook owns: `isStreaming`, true from the placeholder until the stream
 * ends, and `turnOutcome`, written when it does. This pins that the hook
 * writes them on every way a stream can end — on its own, stopped by the
 * person, and failed after real output — against a stream held OPEN so the
 * mid-turn state can be observed, not just the settled one.
 */

const harness = vi.hoisted(() => ({
  /** The open stream's controller, to push frames and close on demand. */
  controller: null as ReadableStreamDefaultController<Uint8Array> | null,
  /** Whether the consumer cancelled the stream (the person stopped the turn). */
  cancelled: false,
}));

vi.mock('expo/fetch', () => ({
  fetch: async (_url: string, init: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { harness.controller = controller; },
      cancel() { harness.cancelled = true; },
    });
    // A real fetch rejects with AbortError when its signal fires; so does this.
    init.signal?.addEventListener('abort', () => {
      try { harness.controller?.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* already closed */ }
    });
    return { ok: true, status: 200, body };
  },
}));

vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ oxyServices: { getAccessToken: () => 'token' } }) }));
vi.mock('@/lib/device-info', () => ({ collectDeviceInfo: async () => ({}) }));
vi.mock('@/lib/hooks/use-agent-row-preview', () => ({ useAgentRowPreview: () => () => {} }));
vi.mock('@/lib/hooks/use-user-data', () => ({ USER_MEMORY_QUERY_KEY: ['memory'] }));
vi.mock('@/lib/stores/model-store', () => ({
  useModelStore: { getState: () => ({ webSearch: true, setSelectedModel: () => {} }) },
}));
vi.mock('@/lib/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ addCanvasArtifact: () => {}, setRightPanel: () => {}, openAgentPanel: () => {} }) },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ default: { t: (k: string) => k } }));

import { useStreamingChat } from '@/lib/hooks/use-streaming-chat';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useStreamingChat>;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  api = useStreamingChat('http://test.invalid/chat', 'c1');
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

const encoder = new TextEncoder();
const contentFrame = (content: string, meta?: { synthetic: boolean; retryable: boolean }) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }], ...(meta ? { alia_meta: meta } : {}) })}\n\n`;

/** Push frames into the open stream and let the hook's batched flush land. */
async function deliver(...frames: string[]) {
  await act(async () => {
    for (const frame of frames) harness.controller?.enqueue(encoder.encode(frame));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

async function close() {
  await act(async () => {
    harness.controller?.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

/**
 * Start a turn without awaiting it, and give the placeholder a render.
 *
 * The call is made OUTSIDE `act`, and the promise is handed back inside an
 * object: an async `act` scope waits for work it started, and an async
 * function returning a promise flattens it — either would await the whole
 * turn, and the point here is a stream that stays open. Each observation
 * is flushed through its own `act`, so what is asserted is committed state.
 */
async function begin(): Promise<{ outcome: Promise<string> }> {
  let outcome!: Promise<string>;
  // A SYNC act: it commits the send's first updates without waiting on the
  // promise the callback merely assigns.
  act(() => { outcome = api.append({ role: 'user', content: 'hello?' }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { outcome };
}

const reply = () => api.messages[api.messages.length - 1];

beforeEach(() => {
  harness.controller = null;
  harness.cancelled = false;
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('the assistant message’s lifecycle stamp', () => {
  it('is streaming from the placeholder through every token, and completed once the stream ends', async () => {
    await mount();
    const { outcome } = await begin();

    expect(reply()).toMatchObject({ role: 'assistant', content: '', isStreaming: true });
    expect(reply().turnOutcome).toBeUndefined();

    // The first token, and more: content alone must not end the turn.
    await deliver(contentFrame('The'));
    expect(reply()).toMatchObject({ content: 'The', isStreaming: true });
    await deliver(contentFrame(' answer'));
    expect(reply()).toMatchObject({ content: 'The answer', isStreaming: true });
    expect(api.isLoading).toBe(true);

    await close();
    expect(await outcome).toBe('sent');
    expect(reply()).toMatchObject({ content: 'The answer', isStreaming: false, turnOutcome: 'completed' });
    expect(api.isLoading).toBe(false);
  });

  it('is cancelled when the person stops it, keeping the partial output', async () => {
    await mount();
    const { outcome } = await begin();
    await deliver(contentFrame('Half of'));

    await act(async () => { api.stop(); await new Promise((resolve) => setTimeout(resolve, 80)); });

    expect(await outcome).toBe('aborted');
    expect(reply()).toMatchObject({ content: 'Half of', isStreaming: false, turnOutcome: 'cancelled' });
    expect(api.isLoading).toBe(false);
  });

  it('is failed when real output is followed by the server’s stand-in tail', async () => {
    await mount();
    const { outcome } = await begin();
    await deliver(contentFrame('Real output'));
    await deliver(contentFrame('all models are busy', { synthetic: true, retryable: true }));
    await close();

    expect(await outcome).toBe('sent');
    expect(reply()).toMatchObject({ content: 'Real output', isStreaming: false, turnOutcome: 'failed' });
    expect(api.failedTurn).toMatchObject({ anchorMessageId: reply().id, partial: true });
  });
});
