/**
 * Expiry Sweep Registry — the replacement for this service's Mongo TTL indexes.
 *
 * Postgres has no TTL index. Mongo reaped; Postgres does not. A table ported
 * without an entry here grows FOREVER — no error, no failing test, no symptom of
 * any kind until disk — and it is invisible in review, because the thing doing
 * the work was never in this codebase to be seen going missing.
 *
 * `db/__tests__/ttlRegistryCoverage.test.ts` is what stops that: it WALKS the
 * Mongoose schemas for `expireAfterSeconds` declarations and fails when one has
 * no entry here. A hand-maintained list only ever falls as far behind as the
 * last time somebody remembered it.
 *
 * `packages/api` declares **14** TTL indexes in total. All FOURTEEN are now ported —
 * five in the platform-telemetry batches, `api_key_usage` with providers/billing,
 * three with orgs/dev, `trigger_executions` with automation, `notifications` plus `audio_jobs` with the notifications batch, and the two moderation tables — which were ported in batch 2 and whose entries were MISSING until the chat/memory batch found them. The rest belong to tables that do not exist in
 * Postgres yet, and the coverage test scopes itself to PORTED tables so it
 * tightens automatically as each batch lands rather than needing an allow-list
 * to be pruned.
 *
 * ## The one that cannot be copied, and what to do about it
 *
 * `Notification` is `{createdAt: 1}, expireAfterSeconds: 90d,
 * partialFilterExpression: {status: 'dismissed'}` — a CONDITIONAL delete.
 * `ExpirySweepTarget` is `{table, column, retentionSeconds}` and has no filter,
 * so the condition cannot be handed to it, and the only entry the type permits
 * would delete every notification older than 90 days INCLUDING undismissed ones.
 *
 * The answer is not a predicate field on the shared type. It is to make the
 * CONDITION a COLUMN: a `dismissed_at` written only on dismissal, swept at 90
 * days from IT, with a CHECK binding it to `status = 'dismissed'` so the sweep
 * cannot drift from the condition it replaced. A row never dismissed has NULL
 * and is never swept. That is also more correct than the original — Mongo
 * measured from `createdAt`, so a notification dismissed on day 89 vanished the
 * next day while one dismissed on day 1 survived another 89.
 *
 * Mercaria's `packages/backend/src/db/expiryTargets.ts` is the reference. This
 * lands with the notifications batch; the coverage test already knows about it.
 *
 * ## Every entry is checked for INTENT, not just replicated
 *
 * A Mongo TTL index DELETES, unconditionally, once the deadline passes. None of
 * these holds unprocessed work or history anyone reads afterwards:
 *
 *  - `auth_health_metrics` are hourly counters; the health summary reads a
 *    rolling window far shorter than 7 days.
 *  - `api_usage` backs rate-limit accounting over hours, not days; 48h is
 *    already generous for the longest window any limiter asks about.
 *  - `fallback_events` and `routing_logs` are diagnostics. Their read paths
 *    filter by their own time range independently of the sweep, so a row the
 *    sweep has not reached yet is stale but never unsafe.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { triggerExecutions } from './schema/automation';
import { cacheEntries } from './schema/cache';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { audioJobs, notifications } from './schema/notifications';
import { mcpOauthStates, oauthStates } from './schema/integrations';
import { organizationInvites } from './schema/organizations';
import { MCP_OAUTH_STATE_TTL_SECONDS } from '../models/mcp-oauth-state.js';
import {
  apiKeyUsage,
  apiUsage,
  authHealthMetrics,
  fallbackEvents,
  routingLogs,
} from './schema/telemetry';

const DAY = 24 * 60 * 60;

export const EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: authHealthMetrics,
    column: authHealthMetrics.createdAt,
    retentionSeconds: 7 * DAY,
    reason: 'Hourly auth counters; the health summary reads a far shorter window.',
  },
  {
    table: apiUsage,
    column: apiUsage.timestamp,
    retentionSeconds: 2 * DAY,
    reason: 'Per-key token accounting; no limiter asks about a window beyond hours.',
  },
  {
    table: fallbackEvents,
    column: fallbackEvents.timestamp,
    retentionSeconds: 30 * DAY,
    reason: 'Fallback diagnostics; readers filter by their own range.',
  },
  {
    table: routingLogs,
    column: routingLogs.createdAt,
    retentionSeconds: 90 * DAY,
    reason: 'Routing diagnostics; readers filter by their own range.',
  },
  {
    table: cacheEntries,
    /**
     * `expires_at` is the DEADLINE, not a birth timestamp, so the retention is
     * ZERO — delete once the column is in the past. Mongo spelled the same thing
     * `expireAfterSeconds: 0`. Measuring a duration from this column instead
     * would keep every entry for that duration PAST its own expiry.
     */
    column: cacheEntries.expiresAt,
    retentionSeconds: 0,
    reason: 'An expired cache entry is unservable by definition; the read filters on expires_at too.',
  },
  {
    table: apiKeyUsage,
    /**
     * `timestamp`, NOT a `created_at` — this table has none. Its Mongoose schema
     * sets `timestamps: false`, so the event time is the only clock it carries
     * and the sweep measures from the same column the TTL index did.
     */
    column: apiKeyUsage.timestamp,
    retentionSeconds: 90 * DAY,
    reason:
      'Developer API request records. The longest retention here on purpose: the billing and rate-limit reads work in monthly windows, so a shorter sweep would delete the period being measured.',
  },
  {
    table: triggerExecutions,
    /**
     * From `started_at`, which is this table's ONLY clock — Mongoose sets
     * `timestamps: false`, so there is no `created_at` to measure from and no
     * risk of picking the wrong one.
     */
    column: triggerExecutions.startedAt,
    retentionSeconds: 30 * DAY,
    reason: 'Trigger run history; the readers page by their own range and nothing waits on an old run.',
  },
  {
    table: notifications,
    /**
     * **The conditional TTL, made expressible.** Mongo swept
     * `{createdAt: 1}, 90d, partialFilterExpression: {status: 'dismissed'}` —
     * `ExpirySweepTarget` has no predicate, so the entry its type permits would
     * have deleted every notification older than 90 days, dismissed or not.
     *
     * The condition became a COLUMN instead: `dismissed_at`, written only on
     * dismissal, bound to `status` by a CHECK so the two cannot drift. A row
     * never dismissed has NULL and is never swept.
     *
     * This is deliberately MORE correct than the original, and the one real
     * behaviour change in the port: Mongo measured from `created_at`, so a
     * notification dismissed on day 89 vanished the next day while one dismissed
     * on day 1 survived another 89.
     */
    column: notifications.dismissedAt,
    retentionSeconds: 90 * DAY,
    reason: 'Dismissed notifications, 90 days from the DISMISSAL rather than from creation.',
  },
  {
    table: audioJobs,
    /** From creation. A job is ephemeral and whatever consumed it kept the URL. */
    column: audioJobs.createdAt,
    retentionSeconds: DAY,
    reason: 'Audio generation jobs are ephemeral; the shortest retention in the schema, and intended.',
  },
  {
    table: moderationOutboxes,
    /**
     * `expires_at` IS the deadline, so retention is ZERO — the `cache_entries`
     * shape. **This table can hold UNPROCESSED WORK**: `expires_at` is set at
     * insert and never advanced, so a row that never reaches a terminal state
     * leaves after its deadline whether or not it was ever delivered. That is
     * the source's behaviour and this entry reproduces it; without the entry the
     * table simply grows and the documented behaviour silently stops happening.
     */
    column: moderationOutboxes.expiresAt,
    retentionSeconds: 0,
    reason: 'Delivery jobs past their own deadline; a job stuck that long is not going to succeed.',
  },
  {
    table: moderationEvents,
    /** `expires_at` IS the deadline, so retention is ZERO. */
    column: moderationEvents.expiresAt,
    retentionSeconds: 0,
    reason: 'Inbound dedupe claims; the claim must outlive every redelivery of its event and nothing after.',
  },
  {
    table: organizationInvites,
    /**
     * **The only entry in this registry measuring a NON-ZERO retention from a
     * DEADLINE column, and both ways of "correcting" it destroy data.**
     *
     * Mongo: `{expiresAt: 1}, expireAfterSeconds: 30 days` — a row leaves 30 days
     * AFTER its own expiry. Every other `expires_at` target here
     * (`cache_entries`, and the two moderation tables) is retention ZERO, so the
     * pattern a reader arrives with is the wrong one:
     *
     *  - retention 0 by analogy deletes an invitation the moment it expires,
     *    losing the window where the UI can say "this invitation expired" instead
     *    of 404ing somebody who followed a link from their inbox;
     *  - measuring from `created_at` instead deletes LIVE invitations, because
     *    `expires_at` is required with no default and the caller chooses it — a
     *    31-day-old invite with a 60-day expiry is still valid.
     */
    column: organizationInvites.expiresAt,
    retentionSeconds: 30 * DAY,
    reason:
      'Invitations are kept 30 days past their own expiry so an expired link reads as expired rather than missing.',
  },
  {
    table: mcpOauthStates,
    /**
     * From CREATION, not from a deadline — this table has no deadline column.
     * The row is consumed by an atomic delete when the callback lands, so the
     * sweep only ever reaps ABANDONED flows.
     */
    column: mcpOauthStates.createdAt,
    retentionSeconds: MCP_OAUTH_STATE_TTL_SECONDS,
    reason: 'Abandoned MCP OAuth handshakes; a completed one deletes its own row.',
  },
  {
    table: oauthStates,
    /** `expires_at` IS the deadline, so retention is ZERO — the `cache_entries` shape. */
    column: oauthStates.expiresAt,
    retentionSeconds: 0,
    reason: 'Abandoned integrations OAuth handshakes; the row carries its own deadline.',
  },
];
