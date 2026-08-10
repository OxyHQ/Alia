/**
 * Closed value sets for `library-file`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const FILE_CATEGORIES = ['documents', 'images', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];
