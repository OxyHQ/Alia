/**
 * What a remembered fact is about, and how long an answer should be.
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

// Memory grouping shown in the settings UI (You / Topics / People)
export const MEMORY_TYPES = ['profile', 'topic', 'person'] as const;

export type MemoryType = typeof MEMORY_TYPES[number];

// How long a reply should be, when the user has expressed a preference.
export const MEMORY_RESPONSE_LENGTHS = ['short', 'medium', 'long'] as const;

export type MemoryResponseLength = (typeof MEMORY_RESPONSE_LENGTHS)[number];
