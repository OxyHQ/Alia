import { describe, expect, it, vi } from 'vitest';
import {
  type AliaHostTools,
  HOST_RESULT_MAX_CHARS,
  HostOutcomeQueue,
  hostImageResultProblem,
  type HostResultRecord,
  hostRequest,
} from '../../src/runtime/host-tools';

/** The host-tool queue on its own: once per action, held until delivered. */

const tools = (execute: AliaHostTools['execute']): AliaHostTools => ({
  definitions: [{ name: 'apply_search', description: 'd', inputSchema: { type: 'object' } }],
  execute,
});
const action = (toolCallId: string, name = 'apply_search', app = 'homiio') => ({
  toolCallId,
  app,
  name,
  input: {},
});

describe('HostOutcomeQueue', () => {
  it('never performs one action twice', async () => {
    const execute = vi.fn(async () => ({ outcome: 'applied' as const }));
    const queue = new HostOutcomeQueue();
    expect(await queue.dispatch(action('c1'), tools(execute), 'homiio')).toBe(true);
    expect(await queue.dispatch(action('c1'), tools(execute), 'homiio')).toBe(false);
    // Not even after its outcome was delivered, or the conversation's outcomes were cleared.
    queue.delivered(queue.pending());
    queue.clear();
    expect(await queue.dispatch(action('c1'), tools(execute), 'homiio')).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('holds outcomes until a request carrying them is delivered, and only those', async () => {
    const queue = new HostOutcomeQueue();
    await queue.dispatch(
      action('c1'),
      tools(async () => ({ outcome: 'applied' })),
      'homiio',
    );
    const sent = queue.pending();
    await queue.dispatch(
      action('c2'),
      tools(async () => ({ outcome: 'inline' })),
      'homiio',
    );
    queue.delivered(sent);
    expect(queue.pending()).toEqual([{ toolCallId: 'c2', outcome: 'inline' }]);
  });

  it('answers what it cannot perform instead of performing it', async () => {
    const execute = vi.fn(async () => ({ outcome: 'applied' as const }));
    const queue = new HostOutcomeQueue();
    await queue.dispatch(action('c1', 'apply_search', 'other-app'), tools(execute), 'homiio');
    await queue.dispatch(action('c2', 'unknown'), tools(execute), 'homiio');
    await queue.dispatch(action('c3'), undefined, 'homiio');
    // Tools a chat declares without naming its app belong to no app.
    await queue.dispatch(action('c4'), tools(execute), undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(queue.pending().map((o) => o.outcome)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('keeps an outcome to the contract: a known kind, a detail of at most 500 characters', async () => {
    const queue = new HostOutcomeQueue();
    await queue.dispatch(
      action('c1'),
      tools(async () => ({ outcome: 'weird' as never, detail: 'x'.repeat(900) })),
      'homiio',
    );
    const [outcome] = queue.pending();
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.detail).toHaveLength(500);
  });
});

describe('an awaited action', () => {
  const awaited = (toolCallId: string) => ({
    ...action(toolCallId),
    awaitsResult: true as const,
    turnId: 't-1',
  });

  it('is performed once and its answer sent at once with its result, never queued', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'applied' as const,
      detail: 'ok',
      result: { text: 'hi' },
    }));
    const send = vi.fn(async () => undefined);
    const queue = new HostOutcomeQueue();
    expect(await queue.answer(awaited('c1'), tools(execute), 'homiio', send)).toBe(true);
    expect(await queue.answer(awaited('c1'), tools(execute), 'homiio', send)).toBe(false);
    expect(await queue.dispatch(awaited('c1'), tools(execute), 'homiio')).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      toolCallId: 'c1',
      outcome: 'applied',
      detail: 'ok',
      result: { text: 'hi' },
    });
    expect(queue.pending()).toEqual([]);
  });

  it('answers what it cannot perform, and reports a failed send to the host once', async () => {
    const onUndelivered = vi.fn();
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    const queue = new HostOutcomeQueue();
    await queue.answer(awaited('c2'), { ...tools(vi.fn()), onUndelivered }, 'other-app', send);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      toolCallId: 'c2',
      outcome: 'rejected',
      detail: 'This app did not declare that tool.',
    });
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith(awaited('c2'), new Error('offline'));
  });

  it('sends no result that is not JSON, and none over the bound', async () => {
    const send = vi.fn(async (_answer: HostResultRecord) => undefined);
    const queue = new HostOutcomeQueue();
    await queue.answer(
      awaited('c3'),
      tools(async () => ({ outcome: 'applied', result: () => 1 })),
      'homiio',
      send,
    );
    await queue.answer(
      awaited('c4'),
      tools(async () => ({ outcome: 'applied', result: 'x'.repeat(HOST_RESULT_MAX_CHARS) })),
      'homiio',
      send,
    );
    expect(send.mock.calls.map(([answer]) => answer)).toEqual([
      { toolCallId: 'c3', outcome: 'applied' },
      { toolCallId: 'c4', outcome: 'failed', detail: 'The result was too large to send.' },
    ]);
  });

  it('sends an image result as it is, and answers a malformed one as failed', async () => {
    const send = vi.fn(async (_answer: HostResultRecord) => undefined);
    const queue = new HostOutcomeQueue();
    const screenshot = { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQ', text: 'Docs' };
    await queue.answer(
      awaited('c5'),
      tools(async () => ({ outcome: 'inline', result: screenshot })),
      'homiio',
      send,
    );
    await queue.answer(
      awaited('c6'),
      tools(async () => ({
        outcome: 'inline',
        result: { ...screenshot, data: 'data:image/jpeg;base64,/9j/4AAQ' },
      })),
      'homiio',
      send,
    );
    await queue.answer(
      awaited('c7'),
      tools(async () => ({ outcome: 'inline', result: { ...screenshot, mediaType: 'image/gif' } })),
      'homiio',
      send,
    );
    expect(send.mock.calls.map(([answer]) => answer)).toEqual([
      { toolCallId: 'c5', outcome: 'inline', result: screenshot },
      {
        toolCallId: 'c6',
        outcome: 'failed',
        detail: "An image result's data is standard base64 with no data: prefix.",
      },
      {
        toolCallId: 'c7',
        outcome: 'failed',
        detail: "An image result's mediaType is one of image/jpeg, image/png, image/webp.",
      },
    ]);
    expect(hostImageResultProblem({ type: 'snapshot' })).toBeNull();
    expect(hostImageResultProblem({ ...screenshot, url: 'x' })).toBe(
      'An image result has no "url".',
    );
  });
});

describe('hostRequest', () => {
  it("declares the chat's app and its tools, and the outcomes only when there are any", () => {
    const declared = tools(async () => ({ outcome: 'applied' }));
    expect(hostRequest('homiio', declared, [])).toEqual({
      app: 'homiio',
      version: 1,
      tools: [{ name: 'apply_search', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(
      hostRequest('homiio', declared, [{ toolCallId: 'c', outcome: 'stale' }])?.outcomes,
    ).toEqual([{ toolCallId: 'c', outcome: 'stale' }]);
  });

  it('declares `awaitsResult` only when a tool awaits, so an older API is never sent the field', () => {
    const declared: AliaHostTools = {
      definitions: [
        { name: 'read_tab', description: 'r', inputSchema: { type: 'object' }, awaitsResult: true },
        {
          name: 'open_tab',
          description: 'o',
          inputSchema: { type: 'object' },
          awaitsResult: false,
        },
      ],
      execute: async () => ({ outcome: 'applied' }),
    };
    expect(hostRequest('astro', declared, [])?.tools).toEqual([
      { name: 'read_tab', description: 'r', inputSchema: { type: 'object' }, awaitsResult: true },
      { name: 'open_tab', description: 'o', inputSchema: { type: 'object' } },
    ]);
  });

  it('names an app without tools, and is nothing without an app', () => {
    expect(hostRequest('mercaria', undefined, [])).toEqual({
      app: 'mercaria',
      version: 1,
      tools: [],
    });
    expect(hostRequest(undefined, undefined, [])).toBeUndefined();
  });
});
