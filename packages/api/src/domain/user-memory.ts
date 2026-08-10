/**
 * Closed value sets and plan limits for `user-memory`.
 *
 * The value sets live OUTSIDE `models/` because the drizzle schema renders its
 * CHECK constraints from these exact tuples — so the Postgres schema depends on
 * them at runtime.
 *
 * The LIMITS and the `MemoryType` alias moved here when the Mongoose model was
 * deleted. They were never model concerns: `getMemoryLimit` reads a subscription
 * plan name and `MAX_MEMORY_TITLE_LENGTH` bounds a request body, and both had
 * importers (`lib/validators/memory-validators.ts`, `lib/tools/user-memory.ts`,
 * `routes/memory.ts`) that never touched the model at all. That is why a census
 * keyed on MODEL bindings could not see them, and why deleting the module
 * without moving them first would have broken four files a call-site count said
 * were not in the slice.
 */

export const MEMORY_TYPES = ['profile', 'topic', 'person'] as const;
export const MEMORY_RESPONSE_LENGTHS = ['short', 'medium', 'long'] as const;
export type MemoryResponseLength = (typeof MEMORY_RESPONSE_LENGTHS)[number];

/** Memory grouping shown in the settings UI (You / Topics / People). */
export type MemoryType = (typeof MEMORY_TYPES)[number];

// How many memories a plan allows.
export const MAX_MEMORIES_FREE = 100;
export const MAX_MEMORIES_PRO = 1000;
export const MAX_MEMORIES_BUSINESS = -1; // Unlimited

// Bounds on one memory's fields, enforced by `lib/validators/memory-validators.ts`.
export const MAX_MEMORY_TITLE_LENGTH = 200;
export const MAX_MEMORY_SUMMARY_LENGTH = 10000;

/** The memory allowance for a plan, by name. `-1` means unlimited. */
export const getMemoryLimit = (planName?: string): number => {
  if (!planName) return MAX_MEMORIES_FREE;

  const plan = planName.toLowerCase();
  if (plan.includes('business') || plan.includes('enterprise')) {
    return MAX_MEMORIES_BUSINESS; // Unlimited
  }
  if (plan.includes('pro')) {
    return MAX_MEMORIES_PRO;
  }

  return MAX_MEMORIES_FREE;
};
