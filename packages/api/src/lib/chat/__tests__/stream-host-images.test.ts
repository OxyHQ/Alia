/**
 * What `runStream` keeps of an awaited host tool's image result (`host-image-result.ts`), and the
 * tool-call bound of a turn whose host awaits results.
 */

import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');
const { HOST_AGENT_TURN_STEP_BOUNDS } = await import('../model-config.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const SCREENSHOT = {
  status: 'inline',
  result: { type: 'image', mediaType: 'image/png', data: PNG, text: 'Pricing' },
};
const PLACEHOLDER = {
  status: 'inline',
  result: { type: 'image', mediaType: 'image/png', text: 'Pricing', omitted: true },
};

describe('a host screenshot after its turn', () => {
  it('reaches neither the client’s frame nor the stored conversation', async () => {
    const { written, toolInvocations } = await runChunks([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'host_astro__screenshot', input: {} },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'host_astro__screenshot',
        output: SCREENSHOT,
      },
      { type: 'text-delta', id: 't', text: 'The pricing page is open.' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const frame = written.find((chunk) => chunk.startsWith('event: alia.tool_result'));
    expect(JSON.parse(frame?.split('data: ')[1] ?? '{}').output).toEqual(PLACEHOLDER);
    expect(written.join('')).not.toContain(PNG);
    expect(toolInvocations).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'host_astro__screenshot',
        state: 'result',
        args: {},
        result: PLACEHOLDER,
      },
    ]);
  });
});

describe('the tool-call bound', () => {
  const calls = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      type: 'tool-call',
      toolCallId: `c${index}`,
      toolName: 'host_astro__click',
      input: {},
    }));

  it('stops an ordinary turn after fifteen calls', async () => {
    const { toolCallCount } = await runChunks([
      ...calls(20),
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(toolCallCount).toBe(16);
  });

  it('lets a turn whose host awaits results make thirty-two', async () => {
    const { toolCallCount } = await runChunks(
      [
        ...calls(20),
        { type: 'text-delta', id: 't', text: 'Done.' },
        { type: 'finish', finishReason: 'stop' },
      ],
      { messages: [] },
      () => undefined,
      { stepBounds: HOST_AGENT_TURN_STEP_BOUNDS },
    );
    expect(toolCallCount).toBe(20);
  });
});
