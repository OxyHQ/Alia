import { describe, expect, it, vi } from 'vitest';
import { type AliaHostTools, HostOutcomeQueue, hostRequest } from '../../src/runtime/host-tools';

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

  it('names an app without tools, and is nothing without an app', () => {
    expect(hostRequest('mercaria', undefined, [])).toEqual({
      app: 'mercaria',
      version: 1,
      tools: [],
    });
    expect(hostRequest(undefined, undefined, [])).toBeUndefined();
  });
});
