/**
 * Expiry Sweep Registry — this service's retention rules.
 *
 * Postgres has no TTL index. A table with a retention rule and no entry here
 * grows FOREVER — no error, no failing test, no symptom of
 * any kind until disk — and it is invisible in review, because the thing doing
 * the work was never in this codebase to be seen going missing.
 *
 * `db/__tests__/ttlRegistryCoverage.test.ts` is what stops that: it holds the
 * closed record of declared TTL rules and fails when one has no entry here, or
 * an entry measures the wrong column or retention.
 *
 * The active registry covers API usage, notifications, moderation, OAuth state
 * and OAuth sessions. Retention rules whose tables have since been
 * dropped (hosted-provider telemetry, auth health counters, routing logs,
 * legacy trigger runs) have no entry because there is nothing left to sweep.
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
 * and is never swept. Measuring from `createdAt` instead would make a
 * notification dismissed on day 89 vanish the next day while one dismissed on
 * day 1 survived another 89.
 *
 * Mercaria's `packages/backend/src/db/expiryTargets.ts` is the reference.
 *
 * ## Every entry is checked for INTENT, not just replicated
 *
 * A sweep DELETES, unconditionally, once the deadline passes. The per-entry
 * comments below say why that is safe for each table.
 */

import type { ExpirySweepTarget } from '@oxy.so/db/expiry';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { conversationShares } from './schema/chat';
import { audioJobs, notifications } from './schema/notifications';
import { MCP_OAUTH_STATE_TTL_SECONDS, mcpOauthStates, oauthStates } from './schema/integrations';
import { emailOutreachDecisions } from './schema/proactive';
import { apiKeyUsage } from './schema/telemetry';
import { oxyFileEvents } from './schema/oxy-files';
import { chatTurnControls } from './schema/chat-turn-controls';
import { chatHostResults } from './schema/chat-host-results';

const DAY = 24 * 60 * 60;

export const EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: chatTurnControls,
    column: chatTurnControls.expiresAt,
    retentionSeconds: 0,
    reason:
      '24-hour turn admission and early-Stop tombstones; no financial or conversation history.',
  },
  {
    table: chatHostResults,
    column: chatHostResults.expiresAt,
    retentionSeconds: 0,
    reason:
      'Awaited host-action answers a crashed replica never read; a read answer is deleted at once.',
  },
  {
    table: apiKeyUsage,
    /**
     * `timestamp`, NOT a `created_at` — this table has none, so the event time is
     * the only clock it carries.
     */
    column: apiKeyUsage.timestamp,
    retentionSeconds: 90 * DAY,
    reason:
      'Developer API request records. The longest retention here on purpose: the billing and rate-limit reads work in monthly windows, so a shorter sweep would delete the period being measured.',
  },
  {
    table: notifications,
    /**
     * **The conditional TTL, made expressible.** The rule is
     * `{createdAt: 1}, 90d, partialFilterExpression: {status: 'dismissed'}` —
     * `ExpirySweepTarget` has no predicate, so the entry its type permits would
     * have deleted every notification older than 90 days, dismissed or not.
     *
     * The condition became a COLUMN instead: `dismissed_at`, written only on
     * dismissal, bound to `status` by a CHECK so the two cannot drift. A row
     * never dismissed has NULL and is never swept.
     *
     * Measuring from `created_at` instead would make a notification dismissed on
     * day 89 vanish the next day while one dismissed on day 1 survived another
     * 89.
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
    reason:
      'Audio generation jobs are ephemeral; the shortest retention in the schema, and intended.',
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
    reason:
      'Inbound dedupe claims; the claim must outlive every redelivery of its event and nothing after.',
  },
  {
    table: oxyFileEvents,
    /**
     * From receipt. A file event's id is remembered only so a redelivery is not
     * handled twice; Oxy dead-letters a delivery after 16 attempts over about
     * four days, so a month outlives every redelivery with room to spare.
     */
    column: oxyFileEvents.createdAt,
    retentionSeconds: 30 * DAY,
    reason: 'Handled Oxy file events, kept only to dedupe at-least-once redeliveries.',
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
  {
    table: conversationShares,
    /**
     * `expires_at` IS the deadline, so retention is ZERO. The public read
     * already refuses an expired link; this only removes the row that would
     * otherwise outlive it forever.
     */
    column: conversationShares.expiresAt,
    retentionSeconds: 0,
    reason: 'Conversation share links past their own deadline (at most 168 hours after sharing).',
  },
  {
    table: emailOutreachDecisions,
    /**
     * From creation. A row is only the idempotency key of one email's
     * outreach decision; Oxy redelivers an event within hours, never months.
     */
    column: emailOutreachDecisions.createdAt,
    retentionSeconds: 90 * DAY,
    reason:
      'Idempotency keys for email outreach (one per considered email); they hold a verdict, never the email.',
  },
];
