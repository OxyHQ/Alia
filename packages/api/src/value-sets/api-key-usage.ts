/**
 * How a developer API call authenticated, and its HTTP method.
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

/** How the caller authenticated. Drives which rate-limit budget the call spends. */
export const API_KEY_USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;

export type ApiKeyUsageAuthType = (typeof API_KEY_USAGE_AUTH_TYPES)[number];

/** The HTTP methods this API exposes. */
export const API_KEY_USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type ApiKeyUsageMethod = (typeof API_KEY_USAGE_METHODS)[number];
