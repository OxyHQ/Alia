/**
 * The `tool.call` event records whether the tool did its job: a tool that ran
 * but answered `{ error }` — a web search that timed out — is a failure, not a
 * success with an empty result.
 */

import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ recordEvent: vi.fn() }));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      agents: child,
      credits: child,
      providers: child,
    },
  };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: H.recordEvent }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

async function outcomeOf(output: unknown) {
  H.recordEvent.mockClear();
  await runChunks([
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'webSearch', input: { query: 'x' } },
    { type: 'tool-result', toolCallId: 'call-1', toolName: 'webSearch', input: {}, output },
  ]);
  const event = H.recordEvent.mock.calls
    .map(([recorded]) => recorded as { type: string; success?: boolean })
    .find((recorded) => recorded.type === 'tool.call');
  return event?.success;
}

describe('the tool.call event', () => {
  it('records a result as a success', async () => {
    expect(await outcomeOf({ results: [{ url: 'https://a.example' }], count: 1 })).toBe(true);
  });

  it('records an answered error as a failure', async () => {
    expect(await outcomeOf({ error: 'Request timed out', results: [], count: 0 })).toBe(false);
  });

  it('does not read an empty or absent error as a failure', async () => {
    expect(await outcomeOf({ error: '', results: [] })).toBe(true);
    expect(await outcomeOf('plain text')).toBe(true);
    expect(await outcomeOf(null)).toBe(true);
  });
});
