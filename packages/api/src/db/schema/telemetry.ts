/**
 * Platform telemetry — per-request usage for Alia's API.
 *
 * Hosted-provider key usage, health and fallback telemetry moved to Kaana, and
 * their dormant Alia tables (`api_usage`, `provider_health`,
 * `fallback_events`) were dropped with `auth_health_metrics` and
 * `routing_logs`, which had lost their writers.
 */

import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxy.so/db';
import { checkOneOf } from './columns';
import {
  API_KEY_USAGE_AUTH_TYPES,
  API_KEY_USAGE_METHODS,
} from '../../domain/api-key-usage.js';

/**
 * One request served through Alia's public API.
 *
 * This is customer API accounting, not upstream-provider usage. Rows written
 * before the `alia_sk_*` developer keys were retired carry `auth_type =
 * 'api_key'` and the key's and app's ids; nothing writes that shape now.
 *
 * TTL: 90 days from `timestamp`. This is the longest retention in the schema and
 * it is deliberate — the read paths bill and rate-limit against monthly windows,
 * so 48 hours (its neighbour's figure) would delete the data mid-period.
 *
 * `api_key_id` and `app_id` named rows of the since-dropped
 * `developer_api_keys` and `developer_apps`. There was never a foreign key,
 * because deletion must not rewrite historical attribution — which is also why
 * the ids survive the tables.
 *
 * Both columns ARE nullable, so `ON DELETE SET NULL` is representable. It is
 * still wrong: NULL already MEANS something on these
 * columns — a session-authenticated or internal call has no key and no app,
 * which is what `auth_type` records. Nulling a deleted key's rows would make
 * them indistinguishable from session traffic, so a row would claim
 * `auth_type = 'api_key'` while naming no key: a state no writer can produce and
 * no reader expects. That is worse than a dangling id, which at least still says
 * which key spent the tokens.
 *
 * Cascade would delete 90 days of billing and rate-limit evidence along with the
 * key, and `RESTRICT` would make a key undeletable for those 90 days.
 *
 * No `created_at`/`updated_at`. The Mongoose schema sets `timestamps: false` and
 * `timestamp` is the event time — adding a second, nearly-identical clock would
 * invite the sweep to be pointed at the wrong one.
 */
export const apiKeyUsage = pgTable(
  'api_key_usage',
  {
    id: generatedId(),
    /** Null for a session-authenticated or internal call. */
    apiKeyId: text(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** Null for a session-authenticated or internal call. */
    appId: text(),
    authType: text({
      enum: API_KEY_USAGE_AUTH_TYPES as unknown as [string, ...string[]],
    })
      .notNull()
      .default('api_key'),
    /** The internal service that made the call, when `auth_type` is `internal`. */
    serviceApp: text(),
    endpoint: text().notNull(),
    method: text({
      enum: API_KEY_USAGE_METHODS as unknown as [string, ...string[]],
    }).notNull(),
    statusCode: integer().notNull(),
    tokensUsed: integer().notNull().default(0),
    creditsUsed: integer().notNull().default(0),
    responseTimeMs: integer('response_time'),
    userAgent: text(),
    timestamp: timestamptz().notNull(),
  },
  (t) => [
    index('api_key_usage_api_key_timestamp_idx').on(
      t.apiKeyId,
      t.timestamp.desc(),
    ),
    index('api_key_usage_oxy_user_timestamp_idx').on(
      t.oxyUserId,
      t.timestamp.desc(),
    ),
    index('api_key_usage_oxy_user_auth_type_timestamp_idx').on(
      t.oxyUserId,
      t.authType,
      t.timestamp.desc(),
    ),
    index('api_key_usage_app_timestamp_idx').on(t.appId, t.timestamp.desc()),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('api_key_usage_timestamp_idx').on(t.timestamp),
    checkOneOf(
      'api_key_usage_auth_type_check',
      t.authType,
      API_KEY_USAGE_AUTH_TYPES,
    ),
    checkOneOf('api_key_usage_method_check', t.method, API_KEY_USAGE_METHODS),
  ],
);
