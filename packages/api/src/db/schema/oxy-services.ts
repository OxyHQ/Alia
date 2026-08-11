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

export const OXY_SERVICE_TOOL_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export type OxyServiceToolMethod = (typeof OXY_SERVICE_TOOL_METHODS)[number];

/**
 * The manifest element types, which live HERE because the column owns them.
 *
 * They were `IOxyServiceTool` and friends on the Mongoose model, and they are the
 * contract `lib/tools/oxy-services.ts` compiles into Zod schemas at runtime — so
 * they outlive the model rather than going with it. A `jsonb` column's element
 * shape is a property of the column; putting it anywhere else would leave the
 * column typed `unknown` and the shape asserted twice.
 *
 * Postgres validates none of this. Mongoose validated only the two `enum`s
 * (`method`, `action`), both of which are now `$type` narrowings with no runtime
 * check inside the document — which is a faithful port of what a `jsonb` column
 * can express, not a loss of one it could. The values are written by the seed
 * script and by service operators, never by an end user.
 */
export interface OxyServiceToolEndpoint {
  method: OxyServiceToolMethod;
  /** e.g. `/email/search` or `/email/messages/{messageId}`. */
  path: string;
  /** tool param -> query param */
  queryMapping?: Record<string, string>;
  /** tool param -> body field */
  bodyMapping?: Record<string, string>;
}

export interface OxyServiceToolResultMapping {
  /** Top-level field to pluck (e.g. `data`). */
  extract?: string;
  /** Fields to keep in the AI summary. */
  summarize?: string[];
  /** Per-tool truncation limit. */
  maxChars?: number;
}

/** One operation Alia can perform on a service. An element of `oxy_services.tools`. */
export interface OxyServiceTool {
  name: string;
  description: string;
  /** JSON Schema supplied by the service — a format this repository does not own. */
  inputSchema: Record<string, unknown>;
  endpoint: OxyServiceToolEndpoint;
  resultMapping?: OxyServiceToolResultMapping;
  /** e.g. `true` for `sendEmail`. */
  confirmBeforeExecute?: boolean;
}

/** One event a service can push. An element of `oxy_services.events`. */
export interface OxyServiceEvent {
  name: string;
  description: string;
  action: OxyServiceEventAction;
}

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
      .$type<OxyServiceStatus>()
      .notNull()
      .default('active'),
    isFirstParty: boolean().notNull().default(false),
    /** An HMAC verification key. A credential — see the file comment. */
    webhookSecret: text(),
    // `$type` is a TypeScript annotation only — no generated SQL changes — and it
    // is what stops the repository handing these back as `unknown`.
    tools: jsonb().$type<OxyServiceTool[]>().notNull().default([]),
    events: jsonb().$type<OxyServiceEvent[]>().notNull().default([]),
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
    action: text({ enum: OXY_SERVICE_EVENT_ACTIONS as unknown as [string, ...string[]] })
      .$type<OxyServiceEventAction>()
      .notNull(),
    status: text({ enum: OXY_SERVICE_EVENT_STATUSES as unknown as [string, ...string[]] })
      .$type<OxyServiceEventStatus>()
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
