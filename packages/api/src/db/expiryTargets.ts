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
 * `packages/api` declares **14** TTL indexes in total. Four are ported in this
 * batch; the other ten belong to tables that do not exist in Postgres yet, and
 * the coverage test scopes itself to PORTED tables so it tightens automatically
 * as each batch lands rather than needing an allow-list to be pruned.
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
 * these four holds unprocessed work or history anyone reads afterwards:
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
import { apiUsage, authHealthMetrics, fallbackEvents, routingLogs } from './schema/telemetry';

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
];
