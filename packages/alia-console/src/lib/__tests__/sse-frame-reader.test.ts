import { describe, expect, it } from 'vitest';

import { createSseFrameReader } from '../sse-frame-reader';
import type { SseFrame } from '../sse-frame-reader';

/**
 * The playground's stream reader, fed the same response split at every byte
 * offset.
 *
 * ## What this defends
 *
 * The playground read its stream as `decoder.decode(value)` then
 * `chunk.split('\n')`, with nothing carried between reads. A frame split
 * across two reads arrived as truncated JSON — `data: {"cho` — failed
 * `JSON.parse`, and was swallowed by an empty `catch`. The token it carried
 * never appeared in the answer, and nothing anywhere said so.
 *
 * ## Why this is the console's first test that RUNS anything
 *
 * The package's two existing suites are source censuses: they read files off
 * disk and parse them with the TypeScript compiler, and
 * `catalogue-not-models.test.ts` says so in its own header. They are the right
 * tool for the invariant they check — no screen may ask Alia to issue a
 * credential — and they execute no product code at all, so a runtime
 * regression is invisible to them by construction. This one executes the code.
 *
 * ## Why "every offset" rather than a few hand-picked splits
 *
 * The bug is a boundary bug, and a hand-picked split is a guess about where
 * the boundary lands. Sweeping every offset removes the guess and costs
 * milliseconds; the property is that the frames come out identical however the
 * bytes were divided.
 */

function readSplitAt(stream: string, at: number): Array<SseFrame> {
  const reader = createSseFrameReader();
  return [...reader.push(stream.slice(0, at)), ...reader.push(stream.slice(at))];
}

function readInChunks(stream: string, size: number): Array<SseFrame> {
  const reader = createSseFrameReader();
  const frames: Array<SseFrame> = [];
  for (let i = 0; i < stream.length; i += size) {
    frames.push(...reader.push(stream.slice(i, i + size)));
  }
  return frames;
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

const STREAM =
  delta('Hola, ') +
  delta('¿qué tal? ') +
  delta('Un párrafo un poco más largo para que no quepa en una sola lectura. ') +
  `data: ${JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } })}\n\n` +
  'data: [DONE]\n\n';

/** What the playground actually does with the frames, minus React. */
function assemble(frames: ReadonlyArray<SseFrame>): { text: string; usage: unknown } {
  let text = '';
  let usage: unknown = null;
  for (const frame of frames) {
    if (frame.data === '[DONE]') continue;
    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: unknown;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) text += content;
    if (parsed.usage) usage = parsed.usage;
  }
  return { text, usage };
}

const WHOLE = assemble(readInChunks(STREAM, STREAM.length));

describe('the playground reads every token, however the stream is divided', () => {
  it('reads the whole stream delivered in one chunk', () => {
    expect(WHOLE.text).toBe(
      'Hola, ¿qué tal? Un párrafo un poco más largo para que no quepa en una sola lectura. ',
    );
    expect(WHOLE.usage).toEqual({ prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 });
  });

  it('loses nothing when the stream is split at EVERY byte offset', () => {
    // The regression. Against the pre-fix reader, a split inside any `data:`
    // line dropped that whole frame — silently, via the empty `catch`.
    for (let at = 1; at < STREAM.length; at++) {
      expect(assemble(readSplitAt(STREAM, at)), `split at ${String(at)}`).toEqual(WHOLE);
    }
  });

  it('loses nothing at any fixed chunk size', () => {
    for (let size = 1; size <= 48; size++) {
      expect(assemble(readInChunks(STREAM, size)), `chunk size ${String(size)}`).toEqual(WHOLE);
    }
  });

  it('emits nothing for a frame that has not finished arriving', () => {
    const reader = createSseFrameReader();
    expect(reader.push('data: {"choices":[{"delta":{"content":"half')).toEqual([]);
  });

  it('passes [DONE] through rather than treating it as JSON', () => {
    const reader = createSseFrameReader();
    expect(reader.push('data: [DONE]\n\n')).toEqual([{ event: '', data: '[DONE]' }]);
  });

  it('tolerates CRLF endings and keep-alive comments', () => {
    const reader = createSseFrameReader();
    expect(reader.push(': keep-alive\r\n\r\ndata: {"a":1}\r\n\r\n')).toEqual([
      { event: '', data: '{"a":1}' },
    ]);
  });
});
