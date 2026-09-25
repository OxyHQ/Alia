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
