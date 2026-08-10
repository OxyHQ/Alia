/**
 * Batch 9d — the execution surface: the sandboxes an agent runs in, and the
 * event log it writes. The last two tables of the agents domain, landing after
 * `agent_sessions` because both name one.
 *
 * ## Two references to `agent_sessions`, and they get OPPOSITE answers
 *
 * `agent_session_resources` (batch 9c) CASCADES and `containers` does NOT, and
 * the reason is what each row IS rather than what it points at:
 *
 * - `agent_session_resources` WAS the session document — an embedded array — so
 *   it cannot outlive the session by construction. Cascading is the faithful
 *   port, not a policy.
 * - `containers` is the AUTHORITY for a live Docker resource. It has its own
 *   lifecycle columns (`status`, `last_activity_at`, `destroyed_at`) and its own
 *   lookup key: `lib/agent/terminal-session.ts:250` and `lib/agent/tools.ts:386`
 *   find a row by `container_id` alone, never through its session. Deleting the
 *   row does not stop the container, so a cascade would destroy the only record
 *   of a sandbox that is still running and still costing money — a leak with
 *   nothing left to reap it by.
 *
 * So `containers.session_id` carries no foreign key, the
 * `agent_sessions.agent_id` answer for a different reason: there the child was
 * somebody's history, here it is a live resource's only record.
 *
 * `event_stream_entries.session_id` DOES cascade. It is the session's own log,
 * unreadable once the session is gone, and it is the largest table in the batch
 * by row count — the one place where orphans would accumulate without bound.
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
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { CONTAINER_SIZES, CONTAINER_STATUSES } from '../../models/container.js';
import { EVENT_STREAM_ENTRY_TYPES } from '../../models/event-stream-entry.js';
import { agentSessions } from './agent-sessions';

/**
 * A Docker sandbox an agent session is using.
 *
 * `container_id` is the DOCKER id and is the real lookup key — but it is only
 * `index: true` in Mongoose, not `unique`, so it stays a plain index here. A
 * unique would be a new tightening on a column two independent creation paths
 * write (`lib/agent/terminal-session.ts:116` and `lib/agent/tools.ts:243`), and
 * the correct move is to audit for duplicates first rather than discover them
 * during the backfill. It is on the audit list as a candidate, the
 * `triggers.schedule` treatment.
 *
 * `exposed_ports` is `integer[]`: a bounded list of plain numbers read whole,
 * the `provider_health.latency_samples` shape. No element has an identity.
 */
export const containers = pgTable(
  'containers',
  {
    id: generatedId(),
    /** The Docker container id. The lookup key every writer actually uses. */
    containerId: text().notNull(),
    name: text().notNull(),
    /** An `agent_sessions` row. NO foreign key — see the file comment. */
    sessionId: text().notNull(),
    /** An `agents` row. No foreign key, for the reason `session_id` has none. */
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    image: text().notNull(),
    size: text({ enum: CONTAINER_SIZES as unknown as [string, ...string[]] })
      .notNull()
      .default('small'),
    status: text({ enum: CONTAINER_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('creating'),
    persistent: boolean().notNull().default(false),
    previewUrl: text(),
    exposedPorts: integer().array().notNull().default([]),
    lastActivityAt: timestamptz(),
    destroyedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('containers_container_id_idx').on(t.containerId),
    index('containers_session_id_idx').on(t.sessionId),
    index('containers_oxy_user_id_idx').on(t.oxyUserId),
    index('containers_oxy_user_status_idx').on(t.oxyUserId, t.status),
    checkOneOf('containers_size_check', t.size, CONTAINER_SIZES),
    checkOneOf('containers_status_check', t.status, CONTAINER_STATUSES),
  ],
);

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
