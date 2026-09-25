import type { ModelMessage } from 'ai';

/**
 * A tool call the AI SDK refused before `execute`.
 *
 * A tool this turn was not given, or input its schema rejects. The SDK hands
 * the reason back to the model for its next step; the call never ran, so it is
 * not something the person or a calling app is shown as having happened.
 */
export function isInvalidToolCall(call: { readonly invalid?: boolean }): boolean {
  return call.invalid === true;
}

/**
 * A completed call and its result, as the two messages a follow-up replays.
 *
 * A result the model reads must follow the assistant message that made the
 * call, in the SDK's own shape — `tool-call` content parts carrying `input`.
 */
export function toolRoundTrip(call: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
}): ModelMessage[] {
  const { toolCallId, toolName, args, result } = call;
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: args ?? {} }] },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: typeof result === 'string' ? result : JSON.stringify(result) },
      }],
    },
  ];
}
