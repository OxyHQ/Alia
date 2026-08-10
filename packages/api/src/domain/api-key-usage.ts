/**
 * Closed value sets for `api-key-usage`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/** How the caller authenticated. Drives which rate-limit budget the call spends. */
export const API_KEY_USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;
export type ApiKeyUsageAuthType = (typeof API_KEY_USAGE_AUTH_TYPES)[number];
/** The HTTP methods this API exposes. */
export const API_KEY_USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiKeyUsageMethod = (typeof API_KEY_USAGE_METHODS)[number];
