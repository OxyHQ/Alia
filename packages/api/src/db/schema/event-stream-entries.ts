/**
 * Batch 9d — the event log an agent session writes. It lands after
 * `agent_sessions` because it names one.
 *
 * This file used to be `containers.ts` and also carried `containers`, the
 * Docker sandboxes a session ran in. The agent sandbox never ran in production;
 * `0073_drop_sandbox_containers` dropped that table, and the event log is what
 * is left.
 *
 * `event_stream_entries.session_id` CASCADES. It is the session's own log,
 * unreadable once the session is gone, and it is the largest agent table by
 * row count — the one place where orphans would accumulate without bound.
 */

import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { generatedId } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { EVENT_STREAM_ENTRY_TYPES } from '../../domain/event-stream-entry.js';
import { agentSessions } from './agent-sessions';

/**
 * One event in a session's stream.
 *
 * This collection exists because the embedded `AgentSession.eventStream` array
 * hit Mongo's 16MB document limit on long sessions — the model's own header
 * says so. Both are still live (see `agent-sessions.ts`); this is the one whose
 * elements have identity anything exercises, which is why it is a table and the
 * embedded copy is `jsonb`.
 *
 * ## `timestamp` is `bigint`, and `integer` would break it on the first write
 *
 * `lib/agent/event-stream.ts:89` writes `Date.now()` — epoch MILLISECONDS,
 * around 1.76e12, which is 800 times past the `integer` maximum. It is a plain
 * `Number` in Mongoose with nothing naming the unit, so the column type is the
 * only place that fact is recorded. Note the read trap that comes with it:
 * `mode: 'number'` is applied by drizzle's result mapper, so a raw `db.execute`
 * hands this back as a STRING while `tsc` types it a number.
 *
 * `seq` stays `integer` — it counts events within one session, and a session
 * bounded by `config_max_steps` cannot approach 2^31.
 *
 * There is deliberately no `created_at`/`updated_at`: Mongoose sets
 * `timestamps: false` and `timestamp` is the clock. Adding them would invent a
 * second answer to when an event happened.
 */
export const eventStreamEntries = pgTable(
  'event_stream_entries',
  {
    id: generatedId(),
    sessionId: text().notNull(),
    seq: integer().notNull(),
    /** Epoch MILLISECONDS. See the table comment — `integer` cannot hold it. */
    timestamp: bigint({ mode: 'number' }).notNull(),
    type: text({ enum: EVENT_STREAM_ENTRY_TYPES as unknown as [string, ...string[]] }).notNull(),
    content: text().notNull(),
    /** `{toolName, args, exitCode, durationMs, tokenEstimate}` — `args` is the
     * tool's own shape, so the whole object is `jsonb`. */
    metadata: jsonb(),
    /** Compacted and summarized by `context-compaction.ts`. */
    archived: boolean().notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'event_stream_entries_session_id_fk',
      columns: [t.sessionId],
      foreignColumns: [agentSessions.id],
    }).onDelete('cascade'),
    // Mongoose declares this unique: one entry per (session, seq).
    uniqueIndex('event_stream_entries_session_seq_key').on(t.sessionId, t.seq),
    // The compaction query: non-archived entries for a session, in order.
    index('event_stream_entries_session_archived_seq_idx').on(t.sessionId, t.archived, t.seq),
    // The audit query: one session's events of a type, over a window.
    index('event_stream_entries_session_type_timestamp_idx').on(t.sessionId, t.type, t.timestamp),
    checkOneOf('event_stream_entries_type_check', t.type, EVENT_STREAM_ENTRY_TYPES),
  ],
);
