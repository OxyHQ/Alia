import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseAliaChatReturn } from '../../src/hooks/useAliaChat';

const mocks = vi.hoisted(() => ({
  oxyServices: null as unknown,
  resolveModelId: vi.fn(async (_apiUrl: string, model?: string) => model),
}));

vi.mock('@oxy.so/services/ui/client', () => ({
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
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"example/model","choices":[{"index":0,"delta":{"content":${escaped}},"finish_reason":null}]}\n\n` +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"example/model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
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
    session: { accessToken: 'active-token' },
    createLinkedClient,
  };
  return { request, createLinkedClient, disposals };
}

let latest: UseAliaChatReturn | null = null;

function current(): UseAliaChatReturn {
  if (latest === null) throw new Error('The hook has not rendered.');
  return latest;
}

let hookOptions: Parameters<typeof useAliaChat>[0];

function Harness(): null {
  latest = useAliaChat({ apiUrl: 'https://api.alia.onl', model: 'example/model', ...hookOptions });
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
    hookOptions = undefined;
    mocks.resolveModelId.mockClear();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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
    expect(config?.headers).toEqual({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    });
    expect(config?.headers).not.toHaveProperty('Authorization');
    expect(config?.url).toBe('/v1/chat/completions');
    expect(current().messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Pregunta'],
      ['assistant', 'Respuesta'],
    ]);
    expect(session.disposals[0]).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });

  it('refuses a caller token that is not the surrounding Oxy session', async () => {
    hookOptions = { accessToken: 'different-session' };
    const session = createSession(async () => successfulResponse());
    const renderer = await renderHarness();

    await act(async () => current().send('Pregunta'));

    expect(session.createLinkedClient).not.toHaveBeenCalled();
    expect(session.request).not.toHaveBeenCalled();
    expect(current().messages).toEqual([]);
    expect(current().error).toBe('The supplied token is not the active Oxy session.');

    await act(async () => renderer.unmount());
  });

  it('aborts the active request when the hook unmounts', async () => {
    const requestSignals: AbortSignal[] = [];
    const session = createSession(
      (config) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignals.push(config.signal);
          config.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
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
    mocks.resolveModelId.mockImplementationOnce(
      () => new Promise<string | undefined>(() => undefined),
    );
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
        config.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
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
    const secondBody = JSON.parse(session.request.mock.calls[1]?.[0].body ?? '{}') as {
      messages?: Array<{ role?: string; content?: string }>;
    };
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
          config.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
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

  it('stops a response body even when the request transport does not propagate abort', async () => {
    let bodyCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const session = createSession(async () => response);
    const renderer = await renderHarness();

    await act(async () => {
      current().send('Pregunta');
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await act(async () => current().stop());
    await vi.waitFor(() => expect(session.disposals[0]).toHaveBeenCalledOnce());

    expect(bodyCancelled).toBe(true);
    expect(current().isStreaming).toBe(false);
    expect(current().messages.map((message) => message.role)).toEqual(['user']);

    await act(async () => renderer.unmount());
  });

  it('turns a terminal stream with no answer into a visible failure', async () => {
    const empty = new Response(
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"example/model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
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
  it('sends photos as image_url parts, in the request and in the user message', async () => {
    const photo = 'data:image/png;base64,AAAA';
    const session = createSession(async () => successfulResponse('Un gato'));
    const renderer = await renderHarness();

    await act(async () => {
      current().send('¿Qué es?', { images: [photo] });
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await waitUntilIdle();

    const parts = [
      { type: 'text', text: '¿Qué es?' },
      { type: 'image_url', image_url: { url: photo } },
    ];
    const body = JSON.parse(session.request.mock.calls[0]?.[0].body ?? '{}');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: parts });
    expect(current().messages[0]?.content).toEqual(parts);

    await act(async () => renderer.unmount());
  });

  it('sends a photo with no caption, without an empty text part', async () => {
    const photo = 'data:image/png;base64,BBBB';
    const session = createSession(async () => successfulResponse('Una foto'));
    const renderer = await renderHarness();

    await act(async () => {
      current().send('   ', { images: [photo] });
      await vi.waitFor(() => expect(session.request).toHaveBeenCalledOnce());
    });
    await waitUntilIdle();

    const body = JSON.parse(session.request.mock.calls[0]?.[0].body ?? '{}');
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: photo } }],
    });

    await act(async () => renderer.unmount());
  });

  it('does not send a turn with neither text nor photos', async () => {
    const session = createSession(async () => successfulResponse());
    const renderer = await renderHarness();

    await act(async () => current().send('  ', { images: [] }));

    expect(session.request).not.toHaveBeenCalled();
    expect(current().messages).toEqual([]);

    await act(async () => renderer.unmount());
  });
  describe('delegated agents', () => {
    const agentFrame = (id: string, name: string, content: string) =>
      `event: alia.agent\ndata: ${JSON.stringify({ eventVersion: 1, agentId: id, agentName: name, agentHandle: id, agentColor: null, content })}\n\n`;
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'example/model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sse = (...frames: string[]) =>
      new Response(`${frames.join('')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });

    it('writes each agent as its own message, before Alia, in the order they answered', async () => {
      createSession(async () =>
        sse(
          agentFrame('lumi', 'Lumi', 'Un violeta suave.'),
          agentFrame('atlas', 'Atlas', 'Lo monto en dos días.'),
          chunk({ content: 'Entonces, el plan.' }),
          chunk({}, 'stop'),
        ),
      );
      const renderer = await renderHarness();
      await act(async () => current().send('Reúne al equipo'));
      await waitUntilIdle();

      const rows = current().messages.map((message) => [
        message.role,
        message.agentInfo?.name ?? null,
        message.content,
      ]);
      expect(rows).toEqual([
        ['user', null, 'Reúne al equipo'],
        ['assistant', 'Lumi', 'Un violeta suave.'],
        ['assistant', 'Atlas', 'Lo monto en dos días.'],
        ['assistant', null, 'Entonces, el plan.'],
      ]);
      expect(
        current()
          .messages.map((message) => message.id)
          .slice(1, 3),
      ).toEqual([expect.stringMatching(/-agent-lumi$/), expect.stringMatching(/-agent-atlas$/)]);

      await act(async () => renderer.unmount());
    });

    const delegation = (id: string, agentId: string, agentName: string) =>
      chunk({
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: {
              name: 'delegateToAgent',
              arguments: JSON.stringify({ agentId, agentName, task: 'x' }),
            },
          },
        ],
      });

    it("opens the agent's message when Alia calls it and fills that same message with its answer", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      createSession(async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(delegation('call-1', 'lumi', 'Lumi')));
              await gate;
              controller.enqueue(encoder.encode(agentFrame('lumi', 'Lumi', 'Un violeta suave.')));
              controller.enqueue(encoder.encode(chunk({ content: 'Listo.' })));
              controller.enqueue(encoder.encode(chunk({}, 'stop')));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const renderer = await renderHarness();
      await act(async () => {
        void current().send('Pregúntale a Lumi');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // Called, not answered: the agent's message exists, empty, before Alia's.
      const asked = current().messages.find((message) => message.agentInfo?.name === 'Lumi');
      expect(asked?.content).toBe('');
      expect(current().messages.indexOf(asked!)).toBeLessThan(
        current().messages.findIndex(
          (message) => message.role === 'assistant' && !message.agentInfo,
        ),
      );

      await act(async () => release());
      await waitUntilIdle();
      const answered = current().messages.filter((message) => message.agentInfo?.name === 'Lumi');
      expect(answered).toHaveLength(1);
      expect(answered[0]!.id).toBe(asked!.id);
      expect(answered[0]!.content).toBe('Un violeta suave.');

      await act(async () => renderer.unmount());
    });

    it('removes the message of an agent that was called and never answered', async () => {
      createSession(async () =>
        sse(
          delegation('call-1', 'lumi', 'Lumi'),
          chunk({ content: 'Sin respuesta.' }),
          chunk({}, 'stop'),
        ),
      );
      const renderer = await renderHarness();
      await act(async () => current().send('Pregúntale a Lumi'));
      await waitUntilIdle();

      expect(current().messages.filter((message) => message.agentInfo)).toHaveLength(0);
      expect(current().messages.at(-1)?.content).toBe('Sin respuesta.');

      await act(async () => renderer.unmount());
    });

    it('leaves no empty reply under agents when Alia says nothing herself', async () => {
      createSession(async () => sse(agentFrame('lumi', 'Lumi', 'Hecho.'), chunk({}, 'stop')));
      const renderer = await renderHarness();
      await act(async () => current().send('Pregúntale a Lumi'));
      await waitUntilIdle();

      expect(current().messages.map((message) => message.agentInfo?.name ?? message.role)).toEqual([
        'user',
        'Lumi',
      ]);

      await act(async () => renderer.unmount());
    });
  });

  describe('a proposed plan', () => {
    const planResponse = () =>
      new Response(
        'event: alia.plan_preview\ndata: {"eventVersion":1,"planId":"plan-1","steps":[{"action":"A","description":"a"},{"action":"B","description":"b"}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"example/model","choices":[{"index":0,"delta":{"content":"Plan listo"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"example/model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const planOf = () => current().messages.find((m) => m.pendingPlan)?.pendingPlan;

    it('is approved by approvePlan, and only that plan', async () => {
      createSession(async () => planResponse());
      const renderer = await renderHarness();
      await act(async () => current().send('Haz un plan'));
      await waitUntilIdle();
      expect(planOf()).toMatchObject({ approved: false, rejected: false });

      await act(async () => current().approvePlan('plan-other'));
      expect(planOf()).toMatchObject({ approved: false });
      await act(async () => current().approvePlan('plan-1'));
      expect(planOf()).toMatchObject({ approved: true, rejected: false });

      await act(async () => renderer.unmount());
    });

    it('is cancelled by rejectPlan', async () => {
      createSession(async () => planResponse());
      const renderer = await renderHarness();
      await act(async () => current().send('Haz un plan'));
      await waitUntilIdle();

      await act(async () => current().rejectPlan('plan-1'));
      expect(planOf()).toMatchObject({ approved: false, rejected: true });
      expect(current().isStreaming).toBe(false);

      await act(async () => renderer.unmount());
    });
  });
});
