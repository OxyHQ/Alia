/**
 * Closed value sets for the person's Alia profile.
 *
 * They live OUTSIDE `models/` because the drizzle schema renders its CHECK constraint from
 * this exact tuple, so the Postgres schema depends on it at runtime. What Alia remembers about
 * a person is Nilo's, with Nilo's own limits.
 */

export const MEMORY_RESPONSE_LENGTHS = ['short', 'medium', 'long'] as const;
export type MemoryResponseLength = (typeof MEMORY_RESPONSE_LENGTHS)[number];
