/**
 * Batch 9c — what an agent DID, who reviewed it, and the teams it belongs to.
 * Every table here references `agents` (batch 9b) and `agents` references none
 * of them back. The sandbox tables this batch also carried —
 * `agent_session_resources` and `container_templates` — were dropped by
 * `0073_drop_sandbox_containers`: the agent sandbox never ran in production.
 *
 * ## Deleting an agent cleans up NOTHING today, and each child answers that
 * differently
 *
 * `routes/agents/crud.ts:323` is a bare `Agent.deleteOne` — no session, review
 * or team membership is touched, so all of them orphan in
 * Mongo right now. That fact does not settle the foreign keys; it means every
 * one of them is a decision this file has to make and state:
 *
 * - **`agent_sessions.agent_id` gets NO foreign key.** A session is the record
 *   of work a person asked for and spent credits on — its `task`, `result` and
 *   event stream are their history, not the agent's. CASCADE would delete it,
 *   `SET NULL` is unrepresentable on a `notNull` column, and `RESTRICT` makes an
 *   agent permanently undeletable once anybody has run it. Every available
 *   answer is worse than none: the `trigger_executions.trigger_id` case, which
 *   is the same shape — an append-only record of what something DID.
 * - **`agent_reviews.agent_id` CASCADES.** A review's entire content is an
 *   opinion of one agent; there is nothing left to read once it is gone, and
 *   `recalculateAgentRating` already returns `null` rather than recomputing when
 *   the agent has been deleted. The `plan_features` case.
 *
 * ## `agent_sessions.event_stream` is `jsonb`, and `event_stream_entries` is a
 * table — both are live
 *
 * `lib/agent/event-stream.ts` persists ONLY to the `EventStreamEntry`
 * collection, which exists to escape Mongo's 16MB document limit. But
 * `lib/agent/runner.ts` also writes `session.eventStream = eventStream.toJSON()`
 * on every save (`:424`, `:678`, `:772`, `:809`), and `getRecentActivity` reads
 * the collection first and falls back to the embedded array — its own comment
 * says "(legacy)". So both stores hold the same events and the port has to carry
 * both.
 *
 * The embedded one is `jsonb`: nothing queries it, nothing filters it, it is
 * read WHOLE in one fallback path and written whole. That is
 * `retrieval_strategies.source_steps` — structured on paper, `jsonb` because the
 * elements have no identity anything exercises. `event_stream_entries` (batch
 * 9d) is where they do, and it gets the indexes.
 *
 * ## `agent_sessions.messages` has ONE writer and NO reader
 *
 * The earlier note here said no site wrote it, from a grep for `session.messages`
 * — and that grep was blind to the only writer, which never names a session
 * variable: `routes/oxy-service-events.ts` passes `messages: [{role, content,
 * timestamp}]` to `AgentSession.create`, one system turn recording that the
 * session came from an autonomous Oxy event. Nothing reads it back, in that file
 * or anywhere else. So it is a write-only column with a real writer, not an
 * empty one — ported faithfully, and the correction is recorded because "confirm
 * it is empty" would have been checked against a table that is not.
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
import { check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { AGENT_SESSION_STATUSES } from '../../domain/agent-session.js';
import { agents } from './agents';
import { automationRuns } from './agency';

/** One item of a session's plan, as `TodoManager` serialises it. */
export interface AgentSessionPlanItem {
  id: number;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

/** One turn of the declared-but-unread `messages` array. See the file comment. */
export interface AgentSessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string | Date;
}

/**
 * One entry of the LEGACY embedded event stream.
 *
 * `event_stream_entries` is the live store and carries the same vocabulary;
 * this is the copy `lib/agent/runner.ts` still writes whole on every save.
 */
export interface AgentSessionEventStreamEntry {
  seq: number;
  timestamp: number;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * One run of an agent against one task.
 *
 * The three flat sub-documents become column groups, per the `routing_logs`
 * rule: `stats_*`, `config_*` and `credit_reservation_*`. Only the last is
 * `default: undefined` in Mongoose, so only its columns are nullable as a group.
 *
 * `plan` is `{objective, items[]}` and splits: `plan_objective` is a column, and
 * `plan_items` is `jsonb` because `lib/agent/runner.ts:298` hands the whole
 * thing to `todoManager.loadFromPersisted` and `:801` validates the array whole.
 * Nothing addresses an item in SQL. `plan = undefined` is a real operation
 * (`:803` clears an invalid plan), so both are nullable and a CHECK keeps them
 * together — the one cross-field rule in this table that the writers actually
 * maintain, since the group is set and cleared as a unit.
 *
 * `credit_reservation_oxy_user_id` is Mongoose's `creditReservation.userId`,
 * renamed for what it holds. It duplicates the session's own `oxy_user_id` in
 * every write today; it is carried rather than collapsed because it records
 * which account the reservation was taken AGAINST at the time, which is not
 * necessarily the same question.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: generatedId(),
    /** An `agents` row. NO foreign key — see the file comment. */
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** Durable product thread and bounded conversation stretch for this turn. */
    threadId: text(),
    conversationId: text(),
    goalId: text(),
    generation: integer().notNull().default(1),
    /** A delegating parent session. Self-referencing, optional. */
    parentSessionId: text(),
    /** The structured automation run this session executes, if any. */
    automationRunId: text(),
    /** Zero-based position within a deterministic multi-agent run. */
    automationStage: integer(),
    status: text({ enum: AGENT_SESSION_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('queued'),
    task: text().notNull(),
    result: text(),

    planObjective: text(),
    /** `{id, text, status}[]`, read and written whole. See the table comment. */
    planItems: jsonb().$type<AgentSessionPlanItem[]>(),

    /** Declared, written by nothing, read by nothing. See the file comment. */
    messages: jsonb().$type<AgentSessionMessage[]>().notNull().default([]),
    /** The LEGACY copy of the events, still written on every save. */
    eventStream: jsonb().$type<AgentSessionEventStreamEntry[]>().notNull().default([]),

    creditReservationOxyUserId: text(),
    creditReservationCreditsReserved: integer(),
    creditReservationInitialFreeCredits: integer(),
    creditReservationInitialPaidCredits: integer(),

    /**
     * `bigint`, not `integer`: a token count over a long session can exceed
     * 2^31, and this one accumulates across every step. `mode: 'number'` keeps
     * it a JS number through the query builder — but NOT through a raw
     * `db.execute`, where postgres.js hands back a string.
     */
    statsTotalTokens: bigint({ mode: 'number' }).notNull().default(0),
    statsTotalSteps: integer().notNull().default(0),
    /** CREDITS, a count. NULL until the session settles. */
    statsCreditsCharged: integer(),
    statsStartedAt: timestamptz(),
    statsCompletedAt: timestamptz(),
    statsLastActivityAt: timestamptz(),

    /**
     * Present only for synchronous product-chat turns. The HTTP request owns
     * the lease; background/autonomous sessions use their worker lifecycle and
     * leave this NULL. An expired lease proves that no live chat request can
     * still own the row, so admission may fail it without guessing from generic
     * activity timestamps.
     */
    chatLeaseExpiresAt: timestamptz(),

    /**
     * Ownership of a BACKGROUND run, the counterpart of `chatLeaseExpiresAt`.
     *
     * The worker that claims the row writes its id and an expiry, and renews
     * the expiry while it works. A crashed or redeployed worker stops renewing,
     * so an expired lease proves nobody is driving the run any more and it may
     * be claimed again — resumed from its persisted counters and events rather
     * than restarted. `runnerAttempts` counts claims, so a run that keeps
     * killing its worker is failed instead of retried forever.
     */
    runnerLeaseOwner: text(),
    runnerLeaseExpiresAt: timestamptz(),
    runnerAttempts: integer().notNull().default(0),

    configMaxSteps: integer().notNull().default(50),
    configMaxTokens: integer().notNull().default(100000),
    configMaxVms: integer().notNull().default(2),

    depth: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_sessions_parent_session_id_fk',
      columns: [t.parentSessionId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'agent_sessions_automation_run_id_fk',
      columns: [t.automationRunId],
      foreignColumns: [automationRuns.id],
    }).onDelete('restrict'),
    index('agent_sessions_agent_id_idx').on(t.agentId),
    index('agent_sessions_oxy_user_id_idx').on(t.oxyUserId),
    index('agent_sessions_status_idx').on(t.status),
    index('agent_sessions_runner_lease_expiry_idx')
      .on(t.runnerLeaseExpiresAt)
      .where(sql`${t.status} = 'running' and ${t.runnerLeaseExpiresAt} is not null`),
    index('agent_sessions_chat_lease_expiry_idx')
      .on(t.chatLeaseExpiresAt)
      .where(sql`${t.chatLeaseExpiresAt} is not null`),
    index('agent_sessions_agent_status_created_idx').on(
      t.agentId,
      t.status,
      t.createdAt.desc(),
    ),
    index('agent_sessions_parent_session_id_idx')
      .on(t.parentSessionId)
      .where(sql`${t.parentSessionId} is not null`),
    uniqueIndex('agent_sessions_automation_run_stage_key')
      .on(t.automationRunId, t.automationStage),
    checkOneOf('agent_sessions_status_check', t.status, AGENT_SESSION_STATUSES),
    /**
     * The plan is set and cleared as a unit by every writer, so both columns are
     * present or neither is. Unlike the permission group on `agents`, nothing
     * here can write half of it: `todoManager.toJSON()` produces both.
     */
    check(
      'agent_sessions_plan_shape_check',
      sql`(${t.planObjective} is null) = (${t.planItems} is null)`,
    ),
    check(
      'agent_sessions_automation_binding_check',
      sql`(${t.automationRunId} is null) = (${t.automationStage} is null)`,
    ),
  ],
);

/**
 * One account's review of one agent.
 *
 * `hidden_by_moderation` is a flag rather than a delete, and the model's own
 * comment explains why: every moderation effect has to be reversible, so an
 * appeal that succeeds can put the review back. `recalculateAgentRating` excludes
 * hidden reviews from the aggregate, which is why the flag has to be readable
 * in SQL rather than implied by absence.
 *
 * `comment` had `maxlength: 1000` in Mongoose and does NOT become a CHECK: a
 * maxlength shapes INPUT at the write path, where the request validators sit,
 * and as a constraint it would fail the backfill on a legacy long string.
 */
export const agentReviews = pgTable(
  'agent_reviews',
  {
    id: generatedId(),
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    rating: integer().notNull(),
    comment: text().notNull().default(''),
    hiddenByModeration: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_reviews_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    // Mongoose declares this unique: one review per account per agent.
    uniqueIndex('agent_reviews_agent_user_key').on(t.agentId, t.oxyUserId),
    index('agent_reviews_agent_created_idx').on(t.agentId, t.createdAt.desc()),
    /**
     * Mongoose declares `min: 1, max: 5` — and 1, not 0, unlike
     * `agents.rating`, which is an AVERAGE and may legitimately be 0 when there
     * are no reviews at all. The two bounds are different on purpose.
     */
    check('agent_reviews_rating_range_check', sql`${t.rating} >= 1 and ${t.rating} <= 5`),
  ],
);

