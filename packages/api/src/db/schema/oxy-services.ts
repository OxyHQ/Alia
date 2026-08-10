/**
 * The Oxy service connector: manifests of what other Oxy apps can do, and the
 * log of events they have pushed to Alia.
 *
 * `oxy_services.webhook_secret` is an HMAC key —
 * `routes/oxy-service-events.ts` verifies every inbound signature with it. Two
 * differences from `bots.webhook_secret` worth stating, because the columns look
 * alike:
 *
 *  - it is a VERIFICATION key, read after the row is found by `service_id`, not a
 *    lookup key. So it could be encrypted, unlike the bot one;
 *  - it was NOT `select: false` in Mongoose, so it has no projection guarantee to
 *    preserve, and this port adds none. Encrypting it here would be a change to
 *    the security posture rather than a faithful port, and belongs in a change
 *    that says so — not in a schema batch.
 *
 * Either way it is a credential: never log it, never select it into a response.
 */

import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

export const OXY_SERVICE_STATUSES = ['active', 'disabled'] as const;
export type OxyServiceStatus = (typeof OXY_SERVICE_STATUSES)[number];

/** What Alia does when a service pushes an event. */
export const OXY_SERVICE_EVENT_ACTIONS = ['notify', 'context', 'autonomous'] as const;
export type OxyServiceEventAction = (typeof OXY_SERVICE_EVENT_ACTIONS)[number];

export const OXY_SERVICE_EVENT_STATUSES = ['received', 'processed', 'failed', 'duplicate'] as const;
export type OxyServiceEventStatus = (typeof OXY_SERVICE_EVENT_STATUSES)[number];

/**
 * One service's manifest.
 *
 * `tools` and `events` are `jsonb`, not child tables. They are ordered
 * declarations read WHOLE when the manifest is loaded — the tool list is turned
 * into Zod schemas at runtime in one pass — with no cross-table reference and no
 * per-element toggle, which is the `fallback_events.attempts` shape rather than
 * the `alia_model_provider_mappings` one. `tools[].inputSchema` is JSON Schema
 * supplied by the service, a format this repository does not own.
 */
export const oxyServices = pgTable(
  'oxy_services',
  {
    id: generatedId(),
    /** The service's stable key, and how every other row names it. */
    serviceId: text().notNull(),
    displayName: text().notNull(),
    description: text().notNull(),
    version: text().notNull(),
    baseUrl: text().notNull(),
    icon: text(),
    status: text({ enum: OXY_SERVICE_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('active'),
    isFirstParty: boolean().notNull().default(false),
    /** An HMAC verification key. A credential — see the file comment. */
    webhookSecret: text(),
    tools: jsonb().notNull().default([]),
    events: jsonb().notNull().default([]),
    contextEndpoint: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('oxy_services_service_id_key').on(t.serviceId),
    checkOneOf('oxy_services_status_check', t.status, OXY_SERVICE_STATUSES),
  ],
);

/**
 * One event a service pushed, and what became of it.
 *
 * `UNIQUE(service_id, oxy_user_id, event_id)` is the IDEMPOTENCY key: it is what
 * makes a redelivery converge on the existing row rather than processing twice,
 * and it is why `status` has a `duplicate` member at all. Losing it would let a
 * service's retry run an autonomous action a second time.
 *
 * `service_id` names `oxy_services.service_id` and carries NO foreign key. This
 * is an append-only record of what a service DID, and the `api_usage.key_id`
 * reasoning applies unchanged: a cascade would delete the evidence, `SET NULL`
 * would destroy the attribution that is the row's content, and `RESTRICT` would
 * make a manifest undeletable. A dangling id preserves what happened.
 */
export const oxyServiceEventLogs = pgTable(
  'oxy_service_event_logs',
  {
    id: generatedId(),
    serviceId: text().notNull(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    /** The service's own id for the event — the half of the idempotency key it controls. */
    eventId: text().notNull(),
    eventName: text().notNull(),
    action: text({ enum: OXY_SERVICE_EVENT_ACTIONS as unknown as [string, ...string[]] }).notNull(),
    status: text({ enum: OXY_SERVICE_EVENT_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('received'),
    payloadHash: text(),
    /** An `agent_sessions` row. No foreign key — that table is batch 9. */
    agentSessionId: text(),
    errorMessage: text(),
    processedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('oxy_service_event_logs_service_user_event_key').on(
      t.serviceId,
      t.oxyUserId,
      t.eventId,
    ),
    index('oxy_service_event_logs_service_id_idx').on(t.serviceId),
    index('oxy_service_event_logs_oxy_user_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('oxy_service_event_logs_status_idx').on(t.status),
    checkOneOf('oxy_service_event_logs_action_check', t.action, OXY_SERVICE_EVENT_ACTIONS),
    checkOneOf('oxy_service_event_logs_status_check', t.status, OXY_SERVICE_EVENT_STATUSES),
    // A processed event records when. Mongo left the two free to disagree.
    check(
      'oxy_service_event_logs_processed_pair_check',
      sql`${t.status} <> 'processed' or ${t.processedAt} is not null`,
    ),
  ],
);
