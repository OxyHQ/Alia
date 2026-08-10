/**
 * Closed value sets for `user-memory`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const MEMORY_TYPES = ['profile', 'topic', 'person'] as const;
export const MEMORY_RESPONSE_LENGTHS = ['short', 'medium', 'long'] as const;
export type MemoryResponseLength = (typeof MEMORY_RESPONSE_LENGTHS)[number];
