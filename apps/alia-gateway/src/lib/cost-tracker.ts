/**
 * Cost Tracker (Standalone)
 *
 * Provides cost calculation and global cost stats for the providers admin panel.
 * This is a simplified standalone version — the main API has a more detailed implementation.
 */

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Simplified cost estimation — real pricing is tracked per-key in key-manager
  return 0;
}

export async function getGlobalCostStats(_period?: string): Promise<{
  totalCost: number;
  totalRequests: number;
  byProvider: Record<string, { cost: number; requests: number }>;
}> {
  return { totalCost: 0, totalRequests: 0, byProvider: {} };
}
