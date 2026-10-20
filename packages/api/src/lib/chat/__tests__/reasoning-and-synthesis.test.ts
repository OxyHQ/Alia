/**
 * What `runStream` relays of the model's thinking, and how a turn that ran
 * tools but wrote no answer ends.
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { child };
});

vi.mock('../../logger.js', () => ({
  log: {
    v1: logMocks.child,
    chat: logMocks.child,
    general: logMocks.child,
    agents: logMocks.child,
    credits: logMocks.child,
    providers: logMocks.child,
  },
}));
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');
const { AliaError, AliaErrorCode } = await import('../../errors/error-codes.js');

/** The `content` of every `alia.reasoning` frame, in order. */
function reasoningFrames(written: readonly string[]): string[] {
  return written
    .filter((frame) => frame.startsWith('event: alia.reasoning'))
    .map((frame) => JSON.parse(frame.split('data: ')[1] ?? '{}').content as string);
}

describe('reasoning on the wire', () => {
  it('relays a sequence of deltas without losing the spaces between words', async () => {
    const { written } = await runChunks([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', text: 'The' },
      { type: 'reasoning-delta', id: 'r', text: ' user' },
      { type: 'reasoning-delta', id: 'r', text: ' is' },
      { type: 'reasoning-delta', id: 'r', text: ' asking about a Mention profile' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    expect(reasoningFrames(written).join('')).toBe('The user is asking about a Mention profile');
  });

  it('keeps a fragment that is only whitespace, and skips an empty one', async () => {
    const { written } = await runChunks([
      { type: 'reasoning-delta', id: 'r', text: 'a' },
      { type: 'reasoning-delta', id: 'r', text: ' ' },
      { type: 'reasoning-delta', id: 'r', text: '' },
      { type: 'reasoning-delta', id: 'r', text: 'b' },
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    expect(reasoningFrames(written).join('')).toBe('a b');
  });

  it('separates the reasoning blocks of successive steps', async () => {
    const { written } = await runChunks([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'First thought.' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'reasoning-start', id: 'r2' },
      { type: 'reasoning-delta', id: 'r2', text: 'Second thought.' },
      { type: 'reasoning-end', id: 'r2' },
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    expect(reasoningFrames(written).join('')).toBe('First thought.\n\nSecond thought.');
  });

  it('treats reasoning-start and reasoning-end as known frames', async () => {
    logMocks.child.warn.mockClear();
    await runChunks([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    expect(logMocks.child.warn).not.toHaveBeenCalledWith(expect.anything(), 'Unhandled chunk type');
  });
});

const toolTurn = [
  { type: 'tool-call', toolCallId: 'c1', toolName: 'webSearch', input: { q: 'x' } },
  { type: 'tool-result', toolCallId: 'c1', toolName: 'webSearch', output: { hits: 1 } },
  { type: 'finish', finishReason: 'tool-calls' },
];

function synthesisModel(parts: readonly LanguageModelV3StreamPart[]) {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls.push(options.prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  return { model, calls };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finishPart: LanguageModelV3StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
};

function runWithSynthesis(parts: readonly LanguageModelV3StreamPart[]) {
  const { model, calls } = synthesisModel(parts);
  // Lazy: the rejection is only created when the test awaits it.
  return { calls, outcome: () => runChunks(toolTurn, { messages: [], model }) };
}

describe('a turn that ran tools and then wrote nothing', () => {
  it('asks the model to answer, so the synthesis pass can produce text', async () => {
    const { outcome, calls } = runWithSynthesis([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Encontré un resultado.' },
      { type: 'text-end', id: 't' },
      finishPart,
    ]);

    const { assistantResponse } = await outcome();
    expect(assistantResponse).toContain('Encontré un resultado.');
    const prompt = calls[0] as Array<{ role: string }>;
    expect(prompt.at(-1)?.role).toBe('user');
  });

  it('fails with a typed EMPTY_RESPONSE when the pass only reasons', async () => {
    const { outcome } = runWithSynthesis([
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'Let me think' },
      { type: 'reasoning-end', id: 'r' },
      finishPart,
    ]);

    const failure = await outcome().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AliaError);
    expect(failure).toMatchObject({ code: AliaErrorCode.EMPTY_RESPONSE, retryable: true });
    expect((failure as Error).message).toMatch(/synthesis produced no assistant answer/);
  });

  it('surfaces the real error of the pass instead of a generic empty answer', async () => {
    const { outcome } = runWithSynthesis([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error('upstream refused the synthesis') },
      finishPart,
    ]);

    await expect(outcome()).rejects.toThrow(/upstream refused the synthesis/);
  });
});
