import { describe, expect, it } from 'vitest';
import {
  AliaChatStreamError,
  consumeAliaChatStream,
  type AliaChatStreamEvent,
} from '../../src/lib/chat-stream';

const encoder = new TextEncoder();

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'profile:v1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function frames(...values: Array<string | Record<string, unknown>>): string {
  return values
    .map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
    .join('');
}

function responseFrom(parts: Array<string | Uint8Array>, contentType = 'text/event-stream; charset=utf-8'): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': contentType } },
  );
}

async function consume(parts: Array<string | Uint8Array>): Promise<AliaChatStreamEvent[]> {
  const events: AliaChatStreamEvent[] = [];
  await consumeAliaChatStream(responseFrom(parts), (event) => events.push(event));
  return events;
}

describe('consumeAliaChatStream', () => {
  it('parses split UTF-8, named product events, tool events and the terminal contract', async () => {
    const wire = [
      ': keep-alive\n\n',
      'event: alia.reasoning\ndata: {"eventVersion":1,"content":"pensando"}\n\n',
      frames(chunk({
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"mañana"}' },
        }],
      })),
      'event: alia.tool_result\ndata: {"eventVersion":1,"tool_call_id":"call-1","name":"lookup","output":{"ok":true}}\n\n',
      'event: alia.plan_preview\ndata: {"eventVersion":1,"planId":"plan-1","steps":[{"action":"Buscar","description":"Busca"},{"action":"Responder","description":"Resume"}]}\n\n',
      frames(chunk({ content: 'Mañana' })),
      frames(chunk({}, 'stop')),
      'event: alia.title\ndata: {"eventVersion":1,"title":"El tiempo","conversationId":"conv-1"}\n\n',
      frames('[DONE]'),
    ].join('');
    const bytes = encoder.encode(wire);
    const splitInsideAccent = wire.indexOf('ñ') + 1;
    const prefixBytes = encoder.encode(wire.slice(0, splitInsideAccent)).byteLength - 1;

    const events = await consume([bytes.slice(0, prefixBytes), bytes.slice(prefixBytes)]);

    expect(events).toEqual([
      { kind: 'reasoning', content: 'pensando' },
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        args: { query: 'mañana' },
      },
      {
        kind: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        output: { ok: true },
      },
      {
        kind: 'plan_preview',
        planId: 'plan-1',
        steps: [
          { action: 'Buscar', description: 'Busca' },
          { action: 'Responder', description: 'Resume' },
        ],
      },
      { kind: 'content', content: 'Mañana' },
    ]);
  });

  it('accepts a delegated agent answer as the visible answer', async () => {
    const events = await consume([
      'event: alia.agent\r\ndata: {"eventVersion":1,"agentId":"a1","agentName":"Sindi","agentHandle":"sindi.bot","agentColor":null,"content":"Ya está"}\r\n\r\n' +
        frames(chunk({}, 'stop'), '[DONE]'),
    ]);

    expect(events).toContainEqual({
      kind: 'agent_answer',
      content: 'Ya está',
      agent: { id: 'a1', name: 'Sindi', avatar: null },
    });
  });

  it('rejects a JSON response even when its body looks like a completion', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ message: { content: 'fake' } }] })));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    await expect(consumeAliaChatStream(response, () => undefined)).rejects.toThrow(
      'Alia returned a non-streaming response.',
    );
    expect(cancelled).toBe(true);
  });

  it.each([
    ['malformed JSON', 'data: {broken}\n\n', 'malformed JSON'],
    ['unknown SSE field', 'retry: 1000\n\n', 'unsupported SSE field'],
    ['unknown named event', 'event: alia.future\ndata: {"eventVersion":1}\n\n', 'Unsupported Alia stream event'],
    ['truncated frame', `data: ${JSON.stringify(chunk({ content: 'partial' }))}`, 'inside an SSE frame'],
    ['empty EOF', '', 'before completing'],
    ['missing DONE', frames(chunk({ content: 'partial' }), chunk({}, 'stop')), 'before completing'],
    ['DONE without finish', frames(chunk({ content: 'partial' }), '[DONE]'), 'without a finish chunk'],
    ['empty assistant', frames(chunk({}, 'stop'), '[DONE]'), 'without an assistant answer'],
    [
      'error frame',
      frames({ error: { message: 'internal detail', type: 'server_error', code: 'failed' } }, '[DONE]'),
      'ended the stream with an error',
    ],
    [
      'content after finish',
      frames(chunk({ content: 'first' }), chunk({}, 'stop'), chunk({ content: 'late' }), '[DONE]'),
      'after its finish chunk',
    ],
    [
      'data after DONE',
      frames(chunk({ content: 'first' }), chunk({}, 'stop'), '[DONE]', chunk({ content: 'late' })),
      'continued after [DONE]',
    ],
    [
      'string plan steps',
      'event: alia.plan_preview\ndata: {"eventVersion":1,"planId":"p1","steps":["one","two"]}\n\n',
      'must be an object',
    ],
    [
      'malformed tool arguments',
      frames(chunk({
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{bad' },
        }],
      })),
      'not valid JSON',
    ],
  ])('fails closed for %s', async (_case, wire, expected) => {
    await expect(consume([wire])).rejects.toThrow(expected);
  });

  it('rejects invalid UTF-8 rather than accepting replacement characters', async () => {
    await expect(consume([new Uint8Array([0xc3, 0x28])])).rejects.toBeInstanceOf(TypeError);
  });

  it('bounds the number of lines it will process', async () => {
    const keepAlives = ': keepalive\n\n'.repeat(4097);
    await expect(consume([keepAlives])).rejects.toThrow('exceeded its line limit');
  });

  it('cancels the response reader after a contract failure', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {broken}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

    await expect(consumeAliaChatStream(response, () => undefined)).rejects.toBeInstanceOf(
      AliaChatStreamError,
    );
    expect(cancelled).toBe(true);
  });
});
