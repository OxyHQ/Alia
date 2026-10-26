import { describe, expect, it } from 'vitest';
import { readAliaEventStream } from '../src/index.js';

const frame = (tool_calls: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`;
async function read(wire: string, size: number) {
  const bytes = new TextEncoder().encode(wire);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size)
        controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readAliaEventStream(body)) events.push(event);
  return events;
}
describe('client-owned tool call fragments', () => {
  it('preserves IDs, indices and fragmented argument bytes across every network split', async () => {
    const first = [
      {
        index: 0,
        id: 'call-a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"pa' },
      },
    ];
    const second = [{ index: 0, function: { arguments: 'th":"README.md"}' } }];
    const wire = frame(first) + frame(second) + 'data: [DONE]\n\n';
    for (let size = 1; size <= wire.length; size++) {
      expect(await read(wire, size)).toEqual([
        { type: 'tool_calls', deltas: first },
        { type: 'tool_calls', deltas: second },
        { type: 'done' },
      ]);
    }
  });
  it.each([
    {},
    [{ index: -1 }],
    [{ index: 1.5 }],
    [{ index: 2 ** 32 }],
    [{ id: 2 }],
    [{ function: { arguments: {} } }],
  ])(
    'refuses malformed fragments without executing or silently dropping them (%j)',
    async (value) => {
      await expect(read(frame(value) + 'data: [DONE]\n\n', 3)).rejects.toMatchObject({
        failure: 'invalid_tool_calls',
      });
    },
  );
});
