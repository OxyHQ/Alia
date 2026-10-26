import { describe, expect, it } from 'vitest';
import {
  AliaChatError,
  completedToolCalls,
  mergeToolCallDeltas,
  streamAliaChat,
  isCreditsRefusal,
  withFailureDetail,
  type StreamedToolCall,
} from '../alia-chat.js';

const chunk = (delta: unknown, extra = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n\n`;
const named = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
async function collect(wire: string, status = 200, chunkSize = 7) {
  const bytes = new TextEncoder().encode(wire);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize)
        controller.enqueue(bytes.slice(at, at + chunkSize));
      controller.close();
    },
  });
  const events = [];
  for await (const event of streamAliaChat({
    baseUrl: 'https://api.example',
    body: { messages: [] },
    fetch: async () =>
      new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } }),
  }))
    events.push(event);
  return events;
}
describe('CLI presentation over the shared server stream', () => {
  it('retains named reasoning/tool results and assembles fragmented client tools', async () => {
    const events = await collect(
      named('alia.reasoning', { content: 'thinking' }) +
        chunk({ content: 'Hello' }) +
        chunk({
          tool_calls: [
            { index: 0, id: 'call-a', function: { name: 'read_file', arguments: '{"pa' } },
          ],
        }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }) +
        named('alia.tool_result', { tool_call_id: 'server-b', name: 'lookup', output: 'result' }) +
        'data: [DONE]\n\n',
    );
    expect(events[0]).toEqual({ type: 'reasoning', text: 'thinking' });
    expect(events[1]).toEqual({ type: 'content', text: 'Hello' });
    expect(events.at(-1)).toEqual({
      type: 'tool_result',
      toolCallId: 'server-b',
      name: 'lookup',
      output: 'result',
    });
    const calls: StreamedToolCall[] = [];
    for (const event of events)
      if (event.type === 'tool_calls') mergeToolCallDeltas(calls, event.deltas);
    expect(completedToolCalls(calls)).toEqual([
      {
        id: 'call-a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);
  });
  it('never presents synthetic recovery prose as an answer', async () => {
    expect(
      await collect(
        chunk({ content: 'Unavailable' }, { alia_meta: { synthetic: true, retryable: true } }) +
          'data: [DONE]\n\n',
      ),
    ).toEqual([{ type: 'synthetic', text: 'Unavailable', retryable: true }]);
  });
  it('recognizes recovery metadata on a terminal frame without content', async () => {
    expect(
      await collect(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"alia_meta":{"synthetic":true,"retryable":true}}\n\ndata: [DONE]\n\n',
      ),
    ).toEqual([
      { type: 'synthetic', text: '', retryable: true },
      { type: 'finish', reason: 'stop', meta: { synthetic: true, retryable: true } },
    ]);
  });
  it('preserves in-stream Stop/refusal codes and support references', async () => {
    await expect(
      collect(
        'data: {"error":{"code":"turn_cancelled","message":"Stopped","reference":"ref-a"}}\n\ndata: [DONE]\n\n',
      ),
    ).rejects.toMatchObject({ code: 'turn_cancelled', reference: 'ref-a', status: null });
  });
  it('keeps HTTP refusal details without exposing untrusted upstream prose', async () => {
    await expect(
      collect(
        '{"error":{"code":"PROVIDER_UNAVAILABLE","message":"private upstream detail","retryable":true,"reference":"ref-a"}}',
        503,
      ),
    ).rejects.toMatchObject({
      message: 'Alia responded 503',
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      reference: 'ref-a',
    });
  });
  it('requires the shared terminal DONE contract instead of saving a truncated answer', async () => {
    await expect(collect(chunk({ content: 'partial' }))).rejects.toMatchObject({
      code: 'STREAM_INCOMPLETE',
      retryable: true,
      message: 'Alia’s response ended before it was complete.',
    });
    await expect(collect('data: invalid\n\n')).rejects.toMatchObject({ failure: 'malformed_json' });
  });
  it('labels credits only by actual credit codes and keeps support references', () => {
    expect(
      isCreditsRefusal(new AliaChatError('quota', { status: 402, code: 'QUOTA_EXCEEDED' })),
    ).toBe(false);
    expect(isCreditsRefusal(new AliaChatError('credits', { code: 'INSUFFICIENT_CREDITS' }))).toBe(
      true,
    );
    expect(
      withFailureDetail('Failed', new AliaChatError('x', { code: 'DOWN', reference: 'ref-a' })),
    ).toBe('Failed (DOWN · Ref ref-a)');
  });
});
