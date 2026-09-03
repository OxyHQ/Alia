/**
 * Platform telemetry — health, usage and routing records.
 *
 * Active product/auth telemetry with explicit retention. Hosted-provider key
 * usage, health and fallback telemetry have moved to Kaana; their legacy Alia
 * tables remain dormant only for the first cutover release's rollback window.
 */

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { API_KEY_USAGE_AUTH_TYPES, API_KEY_USAGE_METHODS } from '../../domain/api-key-usage.js';

/** Dormant rollback state; no hosted inference runtime reads or writes it. */
export const CIRCUIT_STATES = ['closed', 'open', 'half-open'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export const providerHealth = pgTable(
  'provider_health',
  {
    id: generatedId(),
    provider: text().notNull(),
    modelId: text().notNull(),
    successCount: integer().notNull().default(0),
    failureCount: integer().notNull().default(0),
    totalRequests: integer().notNull().default(0),
    successRate: doublePrecision().notNull().default(100),
    averageLatencyMs: doublePrecision().notNull().default(0),
    latencySamples: doublePrecision().array().notNull().default([]),
    lastSuccess: timestamptz(),
    lastFailure: timestamptz(),
    consecutiveFailures: integer().notNull().default(0),
    consecutiveSuccesses: integer().notNull().default(0),
    circuitState: text({ enum: CIRCUIT_STATES }).notNull().default('closed'),
    circuitOpenedAt: timestamptz(),
    halfOpenAttempts: integer().notNull().default(0),
    lastHealthCheck: timestamptz(),
    isHealthy: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provider_health_provider_model_key').on(t.provider, t.modelId),
    checkOneOf('provider_health_circuit_state_check', t.circuitState, CIRCUIT_STATES),
  ],
);

/**
 * Authentication successes and failures, bucketed by hour and method.
 *
 * TTL: 7 days from `created_at`.
 */
export const AUTH_METHODS = ['jwt', 'api_key', 'telegram', 'service'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const authHealthMetrics = pgTable(
  'auth_health_metrics',
  {
    id: generatedId(),
    /**
     * NOT constrained to `AUTH_METHODS`. The Mongoose field was a bare `String`
     * with no enum, so production may already hold values outside that tuple —
     * and a CHECK added here would fail on the first write of one, in the
     * authentication path. The tuple stays a TypeScript narrowing for callers;
     * widening it to a CHECK is a decision for after the backfill audits what is
     * actually stored.
     */
    method: text().notNull(),
    /** Truncated to the hour by the caller; the bucket, not the event time. */
    hour: timestamptz().notNull(),
    successes: integer().notNull().default(0),
    failures: integer().notNull().default(0),
    lastFailure: timestamptz(),
    lastFailureReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('auth_health_metrics_method_hour_key').on(t.method, t.hour),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('auth_health_metrics_created_at_idx').on(t.createdAt),
  ],
);

/** Dormant rollback accounting; no hosted inference runtime reads or writes it. */
export const apiUsage = pgTable(
  'api_usage',
  {
    id: generatedId(),
    keyId: text().notNull(),
    provider: text().notNull(),
    modelId: text().notNull(),
    tokens: integer().notNull().default(0),
    timestamp: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('api_usage_key_timestamp_idx').on(t.keyId, t.timestamp.desc()),
    index('api_usage_provider_idx').on(t.provider),
    index('api_usage_timestamp_idx').on(t.timestamp),
  ],
);

/** Dormant rollback diagnostics; no hosted inference runtime reads or writes it. */
export const fallbackEvents = pgTable(
  'fallback_events',
  {
    id: generatedId(),
    timestamp: timestamptz().notNull(),
    aliasModel: text().notNull(),
    attempts: jsonb().notNull().default([]),
    finalProvider: text(),
    finalModel: text(),
    success: boolean().notNull(),
    totalLatencyMs: integer(),
    fallbackPolicy: text(),
    routingPolicyVersion: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index('fallback_events_timestamp_idx').on(t.timestamp),
    index('fallback_events_alias_timestamp_idx').on(t.aliasModel, t.timestamp.desc()),
    index('fallback_events_success_timestamp_idx').on(t.success, t.timestamp.desc()),
  ],
);

/**
 * Where an inbound message was routed, and why.
 *
 * TTL: 90 days from `created_at`.
 *
 * The Mongoose schema nested `classification` and `routedTo` as sub-documents.
 * They are flattened into real columns here: both have a fixed, known shape that
 * this service owns, so `jsonb` would only hide them from a CHECK and from the
 * planner. `routed_to_*` is nullable as a group — a classified message that was
 * routed nowhere is a real state.
 */
export const ROUTING_TARGET_TYPES = ['agent', 'team', 'user'] as const;
export const ROUTING_STATUSES = ['routed', 'acknowledged', 'escalated', 'resolved'] as const;
export type RoutingTargetType = (typeof ROUTING_TARGET_TYPES)[number];
export type RoutingStatus = (typeof ROUTING_STATUSES)[number];

export const routingLogs = pgTable(
  'routing_logs',
  {
    id: generatedId(),
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    triggerId: text(),
    inboundChannel: text().notNull(),
    inboundSummary: text().notNull(),
    classificationCategory: text().notNull(),
    classificationPriority: text().notNull(),
    classificationConfidence: doublePrecision().notNull().default(0),
    routedToType: text({ enum: ROUTING_TARGET_TYPES }),
    routedToId: text(),
    routedToName: text(),
    reasoning: text().notNull().default(''),
    status: text({ enum: ROUTING_STATUSES }).notNull().default('routed'),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('routing_logs_created_at_idx').on(t.createdAt),
    index('routing_logs_agent_created_at_idx').on(t.agentId, t.createdAt.desc()),
    index('routing_logs_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('routing_logs_routed_to_type_check', t.routedToType, ROUTING_TARGET_TYPES),
    checkOneOf('routing_logs_status_check', t.status, ROUTING_STATUSES),
  ],
);

/**
 * One request served through Alia's public API, per developer key.
 *
 * This is developer/customer API accounting, not upstream-provider usage.
 *
 * TTL: 90 days from `timestamp`. This is the longest retention in the schema and
 * it is deliberate — the read paths bill and rate-limit against monthly windows,
 * so 48 hours (its neighbour's figure) would delete the data mid-period.
 *
 * `api_key_id` and `app_id` name `developer_api_keys` and `developer_apps`.
 * Those tables landed with the orgs/dev batch. The answer is still NO foreign
 * key because deletion must not rewrite historical attribution.
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
    authType: text({ enum: API_KEY_USAGE_AUTH_TYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('api_key'),
    /** The internal service that made the call, when `auth_type` is `internal`. */
    serviceApp: text(),
    endpoint: text().notNull(),
    method: text({ enum: API_KEY_USAGE_METHODS as unknown as [string, ...string[]] }).notNull(),
    statusCode: integer().notNull(),
    tokensUsed: integer().notNull().default(0),
    creditsUsed: integer().notNull().default(0),
    responseTimeMs: integer('response_time'),
    userAgent: text(),
    timestamp: timestamptz().notNull(),
  },
  (t) => [
    index('api_key_usage_api_key_timestamp_idx').on(t.apiKeyId, t.timestamp.desc()),
    index('api_key_usage_oxy_user_timestamp_idx').on(t.oxyUserId, t.timestamp.desc()),
    index('api_key_usage_oxy_user_auth_type_timestamp_idx').on(
      t.oxyUserId,
      t.authType,
      t.timestamp.desc(),
    ),
    index('api_key_usage_app_timestamp_idx').on(t.appId, t.timestamp.desc()),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('api_key_usage_timestamp_idx').on(t.timestamp),
    checkOneOf('api_key_usage_auth_type_check', t.authType, API_KEY_USAGE_AUTH_TYPES),
    checkOneOf('api_key_usage_method_check', t.method, API_KEY_USAGE_METHODS),
  ],
);
