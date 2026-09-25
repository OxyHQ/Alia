/**
 * A replayed tool call is a message the SDK accepts.
 *
 * The tools-off follow-ups (synthesis after a stream that ended on tool
 * results, and the text-emitted tool call) replayed each call as
 * `{ content: '', toolCalls: [{ args }] }` — AI SDK v4's shape. v6 reads the
 * call from `tool-call` content parts carrying `input`, so the result that
 * followed answered a call the model was never shown.
 */

import { describe, expect, it } from 'vitest';
import { modelMessageSchema } from 'ai';
import { toolRoundTrip } from '../tool-calls.js';

describe('toolRoundTrip', () => {
  it('replays the call and its result in the SDK message shape', () => {
    const messages = toolRoundTrip({ toolCallId: 'call-1', toolName: 'webSearch', args: { query: 'x' }, result: { hits: 1 } });

    for (const message of messages) expect(modelMessageSchema.safeParse(message).success).toBe(true);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'webSearch', input: { query: 'x' } }],
    });
    expect(messages[1]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', output: { type: 'text', value: '{"hits":1}' } }],
    });
  });
});
