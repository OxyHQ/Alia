import { NoObjectGeneratedError } from 'ai';

/** Evaluation-only metadata: never serialize provider text, errors or response metadata. */
export function structuredFailureDiagnostics(error: unknown, allowedChoices: readonly string[]) {
  if (!NoObjectGeneratedError.isInstance(error)) return undefined;
  const causeName = error.cause instanceof Error ? error.cause.name : undefined;
  const failureKind =
    error.text === undefined
      ? 'no_text'
      : causeName === 'AI_JSONParseError'
        ? 'parse'
        : causeName === 'AI_TypeValidationError'
          ? 'schema'
          : 'unknown';
  const finishReason = [
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'error',
    'other',
  ].includes(error.finishReason ?? '')
    ? error.finishReason
    : 'unknown';
  const count = (value: number | undefined) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  let choice: string | undefined;
  // Echo only an exact server-enumerated choice, never arbitrary generated strings.
  if (error.text && error.text.length <= 16_384) {
    try {
      const parsed: unknown = JSON.parse(error.text);
      if (parsed && typeof parsed === 'object' && 'choice' in parsed) {
        const value = parsed.choice;
        if (typeof value === 'string' && value.length <= 150 && allowedChoices.includes(value))
          choice = value;
      }
    } catch {
      // Parse failures are evidence; do not repair or retry the selection.
    }
  }
  return {
    failureKind,
    finishReason,
    textPresent: error.text !== undefined,
    textLength: error.text?.length ?? 0,
    ...(choice ? { choice } : {}),
    usage: {
      inputTokens: count(error.usage?.inputTokens),
      outputTokens: count(error.usage?.outputTokens),
      totalTokens: count(error.usage?.totalTokens),
      textTokens: count(error.usage?.outputTokenDetails?.textTokens),
      reasoningTokens: count(error.usage?.outputTokenDetails?.reasoningTokens),
    },
  };
}
