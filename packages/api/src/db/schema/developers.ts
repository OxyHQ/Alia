/**
 * The developer platform: third-party apps registered against Alia, and the API
 * keys they call it with.
 *
 * These two tables are what CLOSE the deferred references left on
 * `api_key_usage` by the providers/billing batch — see the foreign keys below,
 * each decided rather than inherited.
 */

import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkArrayWithin } from './columns';
import { organizations } from './organizations';

/** What an API key is permitted to reach. A closed set this service owns. */
export const DEVELOPER_API_KEY_SCOPES = [
  'chat:read',
  'chat:write',
  'models:read',
  'conversations:read',
  'conversations:write',
  'conversations:delete',
  'memory:read',
  'memory:write',
] as const;
export type DeveloperApiKeyScope = (typeof DEVELOPER_API_KEY_SCOPES)[number];

/**
 * A third-party application registered by a developer.
 *
 * `organization_id` is optional — an app may belong to a person rather than an
 * organization — and cascades, because an app owned by a deleted organization
 * has no one who can administer it.
 */
export const developerApps = pgTable(
  'developer_apps',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    organizationId: text().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    websiteUrl: text(),
    redirectUrls: text().array().notNull().default(sql`'{}'::text[]`),
    icon: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('developer_apps_oxy_user_id_idx').on(t.oxyUserId),
    index('developer_apps_organization_id_idx').on(t.organizationId),
    index('developer_apps_oxy_user_active_idx').on(t.oxyUserId, t.isActive),
  ],
);

/**
 * An API key belonging to an app.
 *
 * **`key_hash` is protected.** It is a sha256 of a live credential, and a hash of
 * a credential is an exact-match ORACLE — anyone holding a candidate key can
 * confirm it against this column. It is not a safer thing to expose than the key
 * itself. `key_prefix` exists for display and is the only identifier safe to
 * show or log. `provider_keys` states the same rule for the same reason.
 *
 * The four `rate_limit_*` columns are the flattened sub-document, and NULL means
 * UNLIMITED rather than zero — a zero would read as "no requests permitted",
 * which is the opposite. Only `requests_per_day` carries a non-null default, at
 * 1000, exactly as Mongoose had it.
 *
 * `scopes` is CHECKed by containment against the tuple, per `reports.categories`
 * — the scalar `in (…)` form compares the whole array against each scalar and is
 * false for everything. An EMPTY array is permitted by containment and is left
 * permitted: a key with no scopes reaches nothing, which is a safe state, not a
 * violation.
 */
export const developerApiKeys = pgTable(
  'developer_api_keys',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    appId: text()
      .notNull()
      .references(() => developerApps.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** sha256 of the credential. Protected — see the table comment. */
    keyHash: text().notNull(),
    /** The first characters, for display. The one identifier safe to log. */
    keyPrefix: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{chat:read,chat:write}'::text[]`),
    expiresAt: timestamptz(),
    lastUsedAt: timestamptz(),
    isActive: boolean().notNull().default(true),
    /** NULL means unlimited, never zero. */
    rateLimitRequestsPerMinute: integer(),
    rateLimitRequestsPerDay: integer().default(1000),
    rateLimitTokensPerMinute: integer(),
    rateLimitTokensPerDay: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('developer_api_keys_key_hash_key').on(t.keyHash),
    index('developer_api_keys_oxy_user_active_idx').on(t.oxyUserId, t.isActive),
    index('developer_api_keys_app_active_idx').on(t.appId, t.isActive),
    checkArrayWithin('developer_api_keys_scopes_check', t.scopes, DEVELOPER_API_KEY_SCOPES),
    // A rate limit of zero is unrepresentable: it would read as "no requests
    // permitted" where the schema spells that absence, and no caller means it.
    check(
      'developer_api_keys_rate_limits_positive_check',
      sql`(${t.rateLimitRequestsPerMinute} is null or ${t.rateLimitRequestsPerMinute} > 0)
        and (${t.rateLimitRequestsPerDay} is null or ${t.rateLimitRequestsPerDay} > 0)
        and (${t.rateLimitTokensPerMinute} is null or ${t.rateLimitTokensPerMinute} > 0)
        and (${t.rateLimitTokensPerDay} is null or ${t.rateLimitTokensPerDay} > 0)`,
    ),
  ],
);
