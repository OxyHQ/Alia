import type { LanguageModelV3Usage } from '@ai-sdk/provider';

/** Oxy reports disjoint token partitions; AI SDK totals include cache/reasoning. */
export function tokenUsageFromUnits(
  units: readonly { unit: string; quantity: number }[] | undefined,
): LanguageModelV3Usage {
  const of = (name: string) => units?.find((unit) => unit.unit === name)?.quantity;
  const total = (base: number | undefined, extra: number | undefined) =>
    base === undefined && extra === undefined ? undefined : (base ?? 0) + (extra ?? 0);
  const input = of('input_tokens'),
    cached = of('cached_input_tokens');
  const output = of('output_tokens'),
    reasoning = of('reasoning_tokens');
  return {
    inputTokens: {
      total: total(input, cached),
      noCache: input,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: { total: total(output, reasoning), text: output, reasoning },
  };
}
