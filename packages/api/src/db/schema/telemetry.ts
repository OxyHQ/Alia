/**
 * Platform telemetry — health, usage and routing records.
 *
 * Five tables that share one property: every row is an OBSERVATION with a
 * deadline, and four of them carried a Mongo TTL index. Mongo reaped them;
 * Postgres does not, so each of those four has an entry in `db/expiryTargets.ts`
 * and that registry has a caller. A table ported without one grows forever with
 * no error and no failing test.
 *
 * All five are self-contained — each is read by exactly one module — which is
 * why they are the first batch: the cheapest place for a mistake in the
 * toolchain to surface.
 */

import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/**
 * Circuit-breaker state per (provider, model).
 *
 * `latency_samples` is `double precision[]` rather than `jsonb`: it is a bounded
 * window of plain numbers with no shape of its own, and an array keeps it
 * summable in SQL if that is ever wanted. `jsonb` is reserved here for values
 * whose FORMAT belongs to somebody else.
 */
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
    /** 0–100. `double precision` because it is a computed ratio, not money. */
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
    // The upsert key. Mongo enforced this and the port keeps it: two rows for
    // one model would split a circuit breaker in half and neither would trip.
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

/**
 * Token consumption per provider key.
 *
 * TTL: 48 hours from `timestamp`.
 *
 * `key_id` carries NO foreign key to `provider_keys`. That table is not ported
 * yet (batch 3), and more importantly usage is an append-only audit of what a
 * key DID: deleting a key must not delete the record that it was used, so this
 * would be `ON DELETE SET NULL` at most rather than a cascade. Revisit when the
 * providers batch lands, deliberately rather than by default.
 */
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

/**
 * One record per request that went through the fallback engine.
 *
 * TTL: 30 days from `timestamp`.
 *
 * `attempts` is `jsonb` — one of the few things that earns it here. It is an
 * ordered list of per-attempt records whose only consumer reads it whole for
 * display, it has no queryable identity of its own, and a child table would
 * mean a join and a cascade for data that is never addressed independently.
 */
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
