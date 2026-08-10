/**
 * Closed value sets for `container`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/**
 * Exported as TUPLES, not union types: the Postgres schema renders its CHECKs
 * from these exact values rather than retyping them, so a constraint and the
 * validator guarding the same column cannot drift apart.
 */
export const CONTAINER_SIZES = ['small', 'medium', 'large'] as const;
export type ContainerSize = (typeof CONTAINER_SIZES)[number];
export const CONTAINER_STATUSES = ['creating', 'running', 'idle', 'stopped', 'destroyed'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];
