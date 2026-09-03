import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseAliaChatReturn } from '../../src/hooks/useAliaChat';

const mocks = vi.hoisted(() => ({
  oxyServices: null as unknown,
  resolveModelId: vi.fn(async (_apiUrl: string, model: string) => model),
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({ oxyServices: mocks.oxyServices }),
}));

vi.mock('../../src/lib/catalogue', () => ({
  resolveModelId: mocks.resolveModelId,
}));

import { useAliaChat } from '../../src/hooks/useAliaChat';

interface RequestConfig {
  readonly method: 'POST';
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

type RequestFunction = (config: RequestConfig) => Promise<Response>;

interface MockSession {
  readonly request: ReturnType<typeof vi.fn<RequestFunction>>;
  readonly createLinkedClient: ReturnType<typeof vi.fn>;
  readonly disposals: Array<ReturnType<typeof vi.fn>>;
}

function successfulResponse(content = 'Hola'): Response {
  const escaped = JSON.stringify(content);
  return new Response(
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"profile:v1","choices":[{"index":0,"delta":{"content":${escaped}},"finish_reason":null}]}\n\n` +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"profile:v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function createSession(implementation: RequestFunction): MockSession {
  const request = vi.fn<RequestFunction>(implementation);
  const disposals: Array<ReturnType<typeof vi.fn>> = [];
  const createLinkedClient = vi.fn(() => {
    const dispose = vi.fn();
    disposals.push(dispose);
    return { client: { requestAuthenticatedResponse: request }, dispose };
  });
  mocks.oxyServices = {
    getAccessToken: () => 'active-token',
    createLinkedClient,
  };
  return { request, createLinkedClient, disposals };
}

let latest: UseAliaChatReturn | null = null;

function current(): UseAliaChatReturn {
  if (latest === null) throw new Error('The hook has not rendered.');
  return latest;
}

function Harness(): null {
  latest = useAliaChat({ apiUrl: 'https://api.alia.onl', model: 'profile:v1' });
  return null;
}

async function renderHarness(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  if (renderer === null) throw new Error('The test harness did not render.');
  return renderer;
}

async function waitUntilIdle(): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => expect(current().isStreaming).toBe(false));
  });
}

describe('useAliaChat request lifecycle', () => {
  beforeEach(() => {
    latest = null;
    mocks.resolveModelId.mockClear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a linked authenticated client and commits only a completed stream', async () => {
    const session = createSession(async () => successfulResponse('Respuesta'));
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Pregunta');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await waitUntilIdle();

    expect(session.createLinkedClient).toHaveBeenCalledWith({ baseURL: 'https://api.alia.onl' });
    const config = session.request.mock.calls[0]?.[0];
    expect(config?.headers).toEqual({ Accept: 'text/event-stream', 'Content-Type': 'application/json' });
    expect(config?.headers).not.toHaveProperty('Authorization');
    expect(config?.url).toBe('/v1/chat/completions');
    expect(current().messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Pregunta'],
      ['assistant', 'Respuesta'],
    ]);
    expect(session.disposals[0]).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it('aborts the active request when the hook unmounts', async () => {
    const requestSignals: AbortSignal[] = [];
    const session = createSession(
      (config) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignals.push(config.signal);
          config.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Pregunta');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await act(async () => renderer.unmount());
    await vi.waitFor(() => expect(session.disposals[0]).toHaveBeenCalledOnce());

    expect(requestSignals[0]?.aborted).toBe(true);
  });

  it('does not wait for a cold catalogue request after unmounting', async () => {
    mocks.resolveModelId.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const session = createSession(async () => successfulResponse());
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Pregunta');
      await vi.waitFor(() => expect(session.createLinkedClient).toHaveBeenCalledOnce());
    });
    await act(async () => renderer.unmount());
    await vi.waitFor(() => expect(session.disposals[0]).toHaveBeenCalledOnce());

    expect(session.request).not.toHaveBeenCalled();
  });

  it('aborts a previous turn before a new send and cannot let the old cleanup win', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const session = createSession((config) => {
      signals.push(config.signal);
      calls += 1;
      if (calls === 2) return Promise.resolve(successfulResponse('Segunda respuesta'));
      return new Promise<Response>((_resolve, reject) => {
        config.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Primera');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledTimes(1));
    });
    await act(async () => {
      current().send('Segunda');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledTimes(2));
    });
    await waitUntilIdle();

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const secondBody = JSON.parse(
      session.request.mock.calls[1]?.[0].body ?? '{}',
    ) as { messages?: Array<{ role?: string; content?: string }> };
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'Primera' },
      { role: 'user', content: 'Segunda' },
    ]);
    expect(current().messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Primera'],
      ['user', 'Segunda'],
      ['assistant', 'Segunda respuesta'],
    ]);
    expect(session.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);

    await act(async () => renderer.unmount());
  });

  it('aborts a stopped turn and removes an answer placeholder that never received data', async () => {
    const signals: AbortSignal[] = [];
    const session = createSession(
      (config) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(config.signal);
          config.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Pregunta');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await act(async () => current().stop());
    await vi.waitFor(() => expect(session.disposals[0]).toHaveBeenCalledOnce());

    expect(signals[0]?.aborted).toBe(true);
    expect(current().isStreaming).toBe(false);
    expect(current().messages.map((message) => message.role)).toEqual(['user']);

    await act(async () => renderer.unmount());
  });

  it('turns a terminal stream with no answer into a visible failure', async () => {
    const empty = new Response(
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"profile:v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
    createSession(async () => empty);
    const renderer = await renderHarness();

    await act(async () => current().send('Pregunta'));
    await waitUntilIdle();

    expect(current().error).toContain('without an assistant answer');
    expect(current().messages.at(-1)?.content).toBe(
      "I'm having trouble connecting right now. Please try again.",
    );

    await act(async () => renderer.unmount());
  });
});
