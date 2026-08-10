/**
 * A Docker sandbox's size and lifecycle.
 *
 * A CLOSED VALUE SET, declared here rather than in the Mongoose model that used
 * to own it. Both stores read this one tuple: the model's `enum` validator and
 * the Postgres CHECK `db/schema` renders. A second copy can disagree with the
 * first, and the disagreement is invisible until a write hits one and not the
 * other.
 *
 * It lives outside `models/` because `db/schema` imports it as a RUNTIME value,
 * so the schema — and every migration's CHECK — would otherwise depend on a
 * Mongoose model the port is retiring. See `db/schema/CONVENTIONS.md`
 * ("Closed value sets").
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
