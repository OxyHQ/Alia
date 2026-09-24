/**
 * Token Counter Utility
 * Estimates token counts for credit calculations
 *
 * Note: This uses a simple approximation since we support multiple providers
 * (OpenAI, Anthropic, Google) with different tokenization schemes.
 * For billing purposes, we use: 1 token ≈ 4 characters (conservative estimate)
 */

/**
 * Estimate token count from text
 * Uses a conservative approximation: 1 token ≈ 4 characters
 * This slightly overestimates compared to most tokenizers, which is safer
 * for credit calculations (we'd rather undercharge than overcharge)
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return estimateTokensForChars(text.length);
}

/**
 * The same estimate for a length already known — a part of a prompt measured
 * where it was added. Rough approximation: 1 token ≈ 4 characters.
 */
export function estimateTokensForChars(charCount: number): number {
  return charCount <= 0 ? 0 : Math.ceil(charCount / 4);
}

/**
 * Estimate tokens for a message with role and content
 */
export function estimateMessageTokens(role: string, content: string): number {
  // Message overhead (role, formatting) ≈ 4 tokens per message
  const messageOverhead = 4;
  const contentTokens = estimateTokenCount(content);

  return messageOverhead + contentTokens;
}
