/**
 * The SSE reader, fed the same stream split at every possible byte offset.
 *
 * ## The defect this exists for
 *
 * `use-streaming-chat.ts` kept `buffer` outside the `reader.read()` loop and
 * `currentEventType` INSIDE it, re-initialised on every chunk. A frame is
 * `event: X\ndata: {…}\n\n`, so any frame whose chunk boundary fell between
 * those two lines lost its type, fell through to the OpenAI-shaped branch,
 * found no `choices[0]`, and was dropped in silence.
 *
 * ## Why "every offset" rather than a couple of hand-picked splits
 *
 * The bug is a boundary bug, and a hand-picked split is a guess about where
 * the boundary lands. A guess would have missed this one: the frames that
 * split in practice are the LARGE ones, because they are the ones that do not
 * fit in a single network read — which is why the symptom was "the title
 * sometimes doesn't arrive" rather than "named events don't work". Sweeping
 * every offset removes the guess, and it is cheap: the property is that the
 * frames come out identical however the bytes were divided.
 *
 * That sweep is the reason this is a module with its own test rather than a
 * few lines inside the hook. No test of the hook could feed it 200 different
 * chunk divisions of one response.
 */

import { describe, expect, it } from 'vitest';

import { createSseFrameReader, type SseFrame } from '../sse-frame-reader';

/** Feed `stream` in chunks of exactly `size` bytes. */
function readInChunks(stream: string, size: number): SseFrame[] {
  const reader = createSseFrameReader();
  const frames: SseFrame[] = [];
  for (let i = 0; i < stream.length; i += size) {
    frames.push(...reader.push(stream.slice(i, i + size)));
  }
  return frames;
}

/** Feed `stream` as exactly two chunks divided at `at`. */
function readSplitAt(stream: string, at: number): SseFrame[] {
  const reader = createSseFrameReader();
  return [...reader.push(stream.slice(0, at)), ...reader.push(stream.slice(at))];
}

const named = (event: string, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const STREAM =
  named('alia.title', { title: 'A conversation about boundary bugs' }) +
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
  named('alia.tool_result', { tool: 'search', result: 'x'.repeat(300) }) +
  'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
  named('alia.agent_session', { sessionId: 'abc' }) +
  'data: [DONE]\n\n';

const EXPECTED: SseFrame[] = [
  { event: 'alia.title', data: '{"title":"A conversation about boundary bugs"}' },
  { event: '', data: '{"choices":[{"delta":{"content":"Hello"}}]}' },
  { event: 'alia.tool_result', data: JSON.stringify({ tool: 'search', result: 'x'.repeat(300) }) },
  { event: '', data: '{"choices":[{"delta":{"content":" world"}}]}' },
  { event: 'alia.agent_session', data: '{"sessionId":"abc"}' },
  { event: '', data: '[DONE]' },
];

describe('frames survive any chunk division', () => {
  it('reads the whole stream delivered in one chunk', () => {
    expect(readInChunks(STREAM, STREAM.length)).toEqual(EXPECTED);
  });

  it('reads the same frames when split at EVERY byte offset', () => {
    // The regression, stated as a sweep. Against the pre-fix logic the named
    // frames arrive with `event: ''` for most of these offsets.
    for (let at = 1; at < STREAM.length; at++) {
      expect(readSplitAt(STREAM, at), `split at ${String(at)}`).toEqual(EXPECTED);
    }
  });

  it('reads the same frames at every fixed chunk size', () => {
    for (let size = 1; size <= 64; size++) {
      expect(readInChunks(STREAM, size), `chunk size ${String(size)}`).toEqual(EXPECTED);
    }
  });

  it('keeps an event name that arrives in a different chunk from its data', () => {
    const reader = createSseFrameReader();
    // The exact shape of the bug: the chunk ends immediately after the
    // `event:` line, so the old code forgot the name before the `data:` line.
    expect(reader.push('event: alia.plan_preview\n')).toEqual([]);
    expect(reader.push('data: {"steps":[]}\n\n')).toEqual([
      { event: 'alia.plan_preview', data: '{"steps":[]}' },
    ]);
  });
});

describe('frame boundaries', () => {
  it('does not let an event name leak into the next frame', () => {
    const reader = createSseFrameReader();
    const frames = reader.push(named('alia.title', { title: 'T' }) + 'data: {"plain":true}\n\n');
    expect(frames.map((f) => f.event)).toEqual(['alia.title', '']);
  });

  it('does not let an event name leak across a chunk boundary either', () => {
    const reader = createSseFrameReader();
    reader.push(named('alia.title', { title: 'T' }));
    expect(reader.push('data: {"plain":true}\n\n')).toEqual([{ event: '', data: '{"plain":true}' }]);
  });

  it('emits nothing for a frame that has not finished arriving', () => {
    const reader = createSseFrameReader();
    expect(reader.push('event: alia.title\ndata: {"title":"half')).toEqual([]);
  });

  it('tolerates CRLF line endings', () => {
    const reader = createSseFrameReader();
    expect(reader.push('event: alia.title\r\ndata: {"title":"T"}\r\n\r\n')).toEqual([
      { event: 'alia.title', data: '{"title":"T"}' },
    ]);
  });

  it('ignores comment lines used as keep-alives', () => {
    const reader = createSseFrameReader();
    expect(reader.push(': keep-alive\n\ndata: {"a":1}\n\n')).toEqual([
      { event: '', data: '{"a":1}' },
    ]);
  });

  it('passes [DONE] through rather than treating it as JSON', () => {
    const reader = createSseFrameReader();
    expect(reader.push('data: [DONE]\n\n')).toEqual([{ event: '', data: '[DONE]' }]);
  });
});
