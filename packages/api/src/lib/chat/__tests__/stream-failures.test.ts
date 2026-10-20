/**
 * How a streamed turn ENDS: the wire's finish_reason vocabulary, the answers
 * that are failures rather than successes, and what the runner does at the
 * tool-call limit. Each case is one way a turn used to be stored and billed as
 * a success that nobody received.
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

/** The `finish_reason` of every frame that carries one. */
function finishReasons(written: readonly string[]): string[] {
  return written
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)).choices?.[0]?.finish_reason)
    .filter((reason): reason is string => typeof reason === 'string');
}

const toolCall = (id: string) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: 'webSearch',
  input: { q: id },
});
const toolResult = (id: string) => ({
  type: 'tool-result',
  toolCallId: id,
  toolName: 'webSearch',
  output: { hits: 1 },
});

describe('finish_reason is OpenAI vocabulary', () => {
  it('words a stop, a truncation and a filter the way OpenAI does', async () => {
    const stop = await runChunks([
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const length = await runChunks([
      { type: 'text-delta', id: 't', text: 'Hola, me quedé sin' },
      { type: 'finish', finishReason: 'length' },
    ]);
    const filter = await runChunks([
      { type: 'text-delta', id: 't', text: 'No puedo' },
      { type: 'finish', finishReason: 'content-filter' },
    ]);
    const other = await runChunks([
      { type: 'text-delta', id: 't', text: 'Hola' },
      { type: 'finish', finishReason: 'other' },
    ]);

    expect(finishReasons(stop.written)).toEqual(['stop']);
    expect(finishReasons(length.written)).toEqual(['length']);
    expect(finishReasons(filter.written)).toEqual(['content_filter']);
    expect(finishReasons(other.written)).toEqual(['stop']);
  });

  it('numbers parallel tool calls apart', async () => {
    const { written } = await runChunks([
      toolCall('a'),
      toolCall('b'),
      toolResult('a'),
      toolResult('b'),
      { type: 'text-delta', id: 't', text: 'Listo' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const indexes = written
      .filter((frame) => frame.includes('"tool_calls"'))
      .map((frame) => JSON.parse(frame.slice(6)).choices[0].delta.tool_calls[0].index);
    expect(indexes).toEqual([0, 1]);
  });
});

describe('an answer with nothing in it is a failure', () => {
  it('fails a length stop that spent its budget thinking', async () => {
    const failure = await runChunks([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', text: 'Hmm, let me think…' },
      { type: 'finish', finishReason: 'length' },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AliaError);
    expect(failure).toMatchObject({ code: AliaErrorCode.EMPTY_RESPONSE, retryable: false });
  });

  it('fails a filtered stop as a content filter, not as an empty success', async () => {
    const failure = await runChunks([{ type: 'finish', finishReason: 'content-filter' }]).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: AliaErrorCode.CONTENT_FILTERED });
  });

  it('fails a stream whose closing frame says it errored', async () => {
    const failure = await runChunks([
      { type: 'text-delta', id: 't', text: 'Voy a' },
      { type: 'finish', finishReason: 'error' },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
  });

  it('control: a tool call with no text is not empty', async () => {
    const { toolInvocations, written } = await runChunks([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'client_tool', input: {} },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);

    expect(toolInvocations).toHaveLength(1);
    expect(finishReasons(written)).toEqual(['tool_calls']);
  });
});

describe('the first byte is content', () => {
  it('does not count the stream opening as the model answering', async () => {
    const onFirstChunk = vi.fn();
    await runChunks(
      [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-delta', id: 't', text: '' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', text: 'Hola' },
        { type: 'finish', finishReason: 'stop' },
      ],
      { messages: [] },
      onFirstChunk,
    );

    // Only the real text-delta: not `start`, `start-step`, an empty delta or `text-start`.
    expect(onFirstChunk).toHaveBeenCalledTimes(1);
  });
});

describe('the tool-call limit', () => {
  it('closes the stream with a finish_reason and the usage of the steps it saw', async () => {
    const chunks: object[] = [];
    for (let i = 0; i < 16; i++) {
      chunks.push(toolCall(`c${i}`), toolResult(`c${i}`));
      chunks.push({
        type: 'finish-step',
        finishReason: 'tool-calls',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      });
    }
    chunks.push({ type: 'finish', finishReason: 'tool-calls' });

    const { written, usage, toolCallCount } = await runChunks(chunks);

    expect(toolCallCount).toBe(16);
    expect(finishReasons(written)).toEqual(['length']);
    // Fifteen calls were within the limit; the sixteenth cut the stream mid-step.
    expect(usage.totalTokens).toBe(14 * 15);
    expect(usage.promptTokens).toBe(10 * 15);
  });
});

describe('the tools-disabled synthesis pass', () => {
  const toolTurn = [
    toolCall('c1'),
    toolResult('c1'),
    { type: 'finish', finishReason: 'tool-calls' },
  ];
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };

  function synthesis(parts: readonly LanguageModelV3StreamPart[]) {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    });
    return runChunks(toolTurn, { messages: [], model });
  }

  it('does not store the text it wrote before it failed as the answer', async () => {
    const failure = await synthesis([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Encontré que la' },
      { type: 'error', error: new Error('upstream dropped the synthesis') },
      { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/upstream dropped the synthesis/);
  });

  it('control: a pass that finishes cleanly is the answer', async () => {
    const { assistantResponse, written } = await synthesis([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Encontré un resultado.' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]);

    expect(assistantResponse).toBe('Encontré un resultado.');
    expect(finishReasons(written)).toEqual(['stop']);
  });
});
