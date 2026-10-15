/**
 * Voice calls: one active call per person, across devices and tabs (ADR 0017 §3a).
 *
 * `lib/voice/call-registry.ts` owns the rules; this is where the authority lives.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamptz } from '@oxy.so/db';

export const VOICE_CALL_STATUSES = ['active', 'ended'] as const;

/**
 * Why a call row ended. A closed set Alia owns, so it is a CHECK, and adding
 * a value is a migration in the same commit.
 */
export const VOICE_CALL_END_REASONS = [
  'hangup',
  'moved_elsewhere',
  'max_duration',
  'idle_timeout',
  'credits_exhausted',
  'error',
  'server_shutdown',
] as const;
export type VoiceCallEndReason = (typeof VOICE_CALL_END_REASONS)[number];

/**
 * One voice call.
 *
 * ## One active row per person is the INDEX's to guarantee
 *
 * `voice_calls_one_active_per_user` is unique on `oxy_user_id` WHERE
 * `status = 'active'`, so two active calls for one person cannot exist, whatever
 * two tasks race. A takeover ends the old row and inserts the new one in one
 * transaction under `pg_advisory_xact_lock(hashtextextended('alia:voice-call:'
 * || user, 0))`; the lock serializes takeovers so neither of two concurrent
 * starts fails on the index, and the index is what holds if anything bypasses
 * the lock.
 *
 * ## The lease says who still holds it
 *
 * `holder_task` is the API task that holds the call's sockets. It renews
 * `lease_expires_at` every 10 s with a statement that matches only while the
 * row is still `active`: zero rows means another device took the call over,
 * and the holder hangs up. A crashed task stops renewing, and an expired lease
 * never blocks a new call — a takeover ends the row whether its lease is live
 * or not. The clock is the SERVER's (`now()`), never a task's.
 *
 * No foreign keys: Oxy owns identity, and a conversation is addressed by its
 * client id like `speech_clips`. The row is history once ended and holds no
 * content.
 */
export const voiceCalls = pgTable(
  'voice_calls',
  {
    id: text().primaryKey(),
    /** An Oxy account. */
    oxyUserId: text().notNull(),
    /** A client-visible conversation id (`conversations.conversation_id`). */
    conversationId: text().notNull(),
    /** The agent the call is with, or NULL for Alia. */
    agentId: text(),
    holderTask: text().notNull(),
    status: text({ enum: VOICE_CALL_STATUSES as unknown as [string, ...string[]] }).notNull(),
    endReason: text({ enum: VOICE_CALL_END_REASONS as unknown as [string, ...string[]] }),
    leaseExpiresAt: timestamptz().notNull(),
    startedAt: timestamptz().notNull().default(sql`now()`),
    endedAt: timestamptz(),
  },
  (t) => [
    uniqueIndex('voice_calls_one_active_per_user')
      .on(t.oxyUserId)
      .where(sql`${t.status} = 'active'`),
    index('voice_calls_oxy_user_started_at_idx').on(t.oxyUserId, t.startedAt),
    check('voice_calls_status_check', sql`${t.status} in ('active', 'ended')`),
    check(
      'voice_calls_end_reason_check',
      sql`${t.endReason} is null or ${t.endReason} in ('hangup', 'moved_elsewhere', 'max_duration', 'idle_timeout', 'credits_exhausted', 'error', 'server_shutdown')`,
    ),
    check(
      'voice_calls_ended_shape_check',
      sql`(${t.status} = 'active' and ${t.endedAt} is null and ${t.endReason} is null) or (${t.status} = 'ended' and ${t.endedAt} is not null and ${t.endReason} is not null)`,
    ),
  ],
);

export type VoiceCallRow = typeof voiceCalls.$inferSelect;
