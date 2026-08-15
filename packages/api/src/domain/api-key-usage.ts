/**
 * Closed value sets for `api-key-usage`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

/** How the caller authenticated. Drives which rate-limit budget the call spends. */
export const API_KEY_USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;
export type ApiKeyUsageAuthType = (typeof API_KEY_USAGE_AUTH_TYPES)[number];
/** The HTTP methods this API exposes. */
export const API_KEY_USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiKeyUsageMethod = (typeof API_KEY_USAGE_METHODS)[number];
