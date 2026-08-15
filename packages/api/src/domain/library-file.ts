/**
 * Closed value sets for `library-file`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

export const FILE_CATEGORIES = ['documents', 'images', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];
