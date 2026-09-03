import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { writeContentChunk } from '../streaming-helpers.js';

/** Collects the raw SSE frames a helper writes, so the chunk JSON can be asserted. */
function captureRes(): { res: Response; frames: string[] } {
  const frames: string[] = [];
  const res = { write: (frame: string) => { frames.push(frame); return true; } } as unknown as Response;
  return { res, frames };
}

function parseFrame(frame: string): Record<string, unknown> {
  expect(frame.startsWith('data: ')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  return JSON.parse(frame.slice(6, -2));
}

describe('writeContentChunk', () => {
  it('tags the chunk with alia_meta when meta is given', () => {
    const { res, frames } = captureRes();

    writeContentChunk(res, 'chatcmpl-test', 'kaana-v1', 'brief interruption', { synthetic: true, retryable: true });

    expect(frames).toHaveLength(1);
    expect(parseFrame(frames[0])).toMatchObject({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      model: 'kaana-v1',
      choices: [{ index: 0, delta: { content: 'brief interruption' }, finish_reason: null, logprobs: null }],
      alia_meta: { synthetic: true, retryable: true },
    });
  });

  it('omits alia_meta entirely when no meta is given', () => {
    const { res, frames } = captureRes();

    writeContentChunk(res, 'chatcmpl-test', 'kaana-v1', 'a real answer');

    expect(frames).toHaveLength(1);
    const chunk = parseFrame(frames[0]);
    expect(chunk).not.toHaveProperty('alia_meta');
    expect(chunk.choices).toEqual([{ index: 0, delta: { content: 'a real answer' }, finish_reason: null, logprobs: null }]);
  });
});
